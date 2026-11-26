export const MAC_SCRIPT = String.raw`
ObjC.import('Foundation');
ObjC.import('stdlib');

if (!$.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/MediaRemote.framework/').load) $.exit(2);
ObjC.bindFunction('MRMediaRemoteSendCommand', ['bool', ['unsigned int', 'id']]);

const Controller = $.NSClassFromString('MRNowPlayingController');
const ControllerConfig = $.NSClassFromString('MRNowPlayingControllerConfiguration');
const QueueRequest = $.NSClassFromString('MRPlaybackQueueRequest');
if (!Controller || !ControllerConfig || !QueueRequest) $.exit(2);

const CMD = { play: 0, pause: 1, toggle: 2, next: 4, prev: 5, seek: 24, repeat: 25, shuffle: 26 };
const CF_EPOCH = 978307200;

const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
function send(obj) {
    stdout.writeData($(JSON.stringify(obj) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
}

function str(v) {
    if (!v || v.isNil()) return undefined;
    const s = ObjC.unwrap(v);
    return typeof s === 'string' && s.length ? s : undefined;
}
function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : 0;
}
function truthy(v) {
    return v === true || v === 1 || v === 'true' || v === '1';
}

const lines = [];
let stdinBuf = '';
let stdinClosed = false;
ObjC.registerSubclass({
    name: 'VcWmcStdinReader',
    methods: {
        'onData:': {
            types: ['void', ['id']],
            implementation: function (n) {
                const data = n.userInfo.objectForKey('NSFileHandleNotificationDataItem');
                if (!data || data.isNil() || Number(data.length) === 0) { stdinClosed = true; return; }
                stdinBuf += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
                let i;
                while ((i = stdinBuf.indexOf('\n')) !== -1) {
                    lines.push(stdinBuf.slice(0, i));
                    stdinBuf = stdinBuf.slice(i + 1);
                }
                n.object.readInBackgroundAndNotify;
            }
        }
    }
});
const stdinReader = $.VcWmcStdinReader.alloc.init;
const stdin = $.NSFileHandle.fileHandleWithStandardInput;
$.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(stdinReader, 'onData:', $.NSFileHandleReadCompletionNotification, stdin);
stdin.readInBackgroundAndNotify;

let controller = null;
let controllerSince = 0;
function makeController() {
    if (controller) controller.endLoadingUpdates;
    const config = ControllerConfig.alloc.initWithDestination(Controller.localRouteController.configuration.destination);
    const queueRequest = QueueRequest.defaultPlaybackQueueRequest;
    queueRequest.setArtworkWidth(600);
    queueRequest.setArtworkHeight(600);
    config.setPlaybackQueueRequest(queueRequest);
    config.setRequestPlaybackQueue(true);
    config.setRequestPlaybackState(true);
    config.setRequestSupportedCommands(true);
    config.setRequestClientProperties(true);
    controller = Controller.alloc.initWithConfiguration(config);
    controller.beginLoadingUpdates;
    controllerSince = Date.now();
}

function sendCommand(id, options) {
    $.MRMediaRemoteSendCommand(id, $(options || {}));
}

function handle(line) {
    const parts = line.trim().split(' ');
    const arg = parts[1] || '';
    switch (parts[0]) {
        case 'toggle': case 'play': case 'pause': case 'next': case 'prev':
            sendCommand(CMD[parts[0]]);
            break;
        case 'seek': {
            const ms = Number(arg);
            if (isFinite(ms) && ms >= 0) sendCommand(CMD.seek, { kMRMediaRemoteOptionPlaybackPosition: ms / 1000 });
            break;
        }
        case 'shuffle':
            sendCommand(CMD.shuffle, { kMRMediaRemoteOptionShuffleMode: arg === 'true' ? 3 : 1 });
            break;
        case 'repeat':
            sendCommand(CMD.repeat, { kMRMediaRemoteOptionRepeatMode: arg === 'track' ? 2 : arg === 'list' ? 3 : 1 });
            break;
    }
}

function mimeOf(b64) {
    if (b64.startsWith('/9j/')) return 'image/jpeg';
    if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
    if (b64.startsWith('R0lGOD')) return 'image/gif';
    if (b64.startsWith('UklGR')) return 'image/webp';
    return 'image/jpeg';
}

let lastJson = '';
let lastThumbKey = null;
let fallbackElapsed = null;
let fallbackElapsedAt = 0;

function readState() {
    const state = { type: 'state', active: false, sessions: [], selected: 'auto' };
    const r = controller.response;
    if (!r || r.isNil()) return state;
    const client = r.playerPath.client;
    if (!client || client.isNil()) return state;
    const queue = r.playbackQueue;
    if (!queue || queue.isNil()) return state;
    const items = queue.contentItems;
    const item = items && !items.isNil() && num(items.count) > 0 ? items.objectAtIndex(0) : null;
    const md = item ? item.metadata : null;
    const info = queue.nowPlayingInfo;
    const infoGet = k => info && !info.isNil() ? info.objectForKey('kMRMediaRemoteNowPlayingInfo' + k) : null;

    const app = str(client.bundleIdentifier) || str(client.displayName) || 'unknown';
    const title = (md && str(md.title)) || str(infoGet('Title'));
    if (!title) return state;

    const pbState = num(r.playbackState);
    const rate = num(r.playbackRate);
    const status = pbState === 1 ? 'playing' : pbState === 2 || pbState === 4 ? 'paused' : pbState === 3 ? 'stopped' : rate > 0 ? 'playing' : 'paused';

    const duration = md ? num(md.duration) : 0;
    const elapsed = md ? num(md.elapsedTime) : 0;
    const timestamp = md ? num(md.elapsedTimeTimestamp) : 0;
    let updatedAt;
    if (timestamp > 0) {
        updatedAt = Math.round((timestamp + CF_EPOCH) * 1000);
    } else {
        if (elapsed !== fallbackElapsed) { fallbackElapsed = elapsed; fallbackElapsedAt = Date.now(); }
        updatedAt = fallbackElapsedAt;
    }

    const enabled = {};
    let hasCommandList = false;
    const commands = r.supportedCommands;
    if (commands && !commands.isNil()) {
        const n = num(commands.count);
        hasCommandList = n > 0;
        for (let i = 0; i < n; i++) {
            const c = commands.objectAtIndex(i);
            if (truthy(c.enabled)) enabled[num(c.command)] = true;
        }
    }
    const can = id => hasCommandList ? !!enabled[id] : id <= CMD.prev;

    const shuffleMode = num(r.shuffleMode);
    const repeatMode = num(r.repeatMode);

    const artist = (md && str(md.trackArtistName)) || str(infoGet('Artist'));
    const album = (md && str(md.albumName)) || str(infoGet('Album'));
    const trackKey = [app, title, artist || '', album || ''].join('|');

    Object.assign(state, {
        active: true,
        sessions: [app],
        app,
        appName: str(client.displayName),
        title,
        artist,
        album,
        thumbKey: trackKey,
        status,
        positionMs: Math.round(elapsed * 1000),
        startMs: 0,
        endMs: Math.round(duration * 1000),
        updatedAt,
        shuffle: shuffleMode === 0 ? null : shuffleMode !== 1,
        repeat: repeatMode === 1 ? 'none' : repeatMode === 2 ? 'track' : repeatMode === 3 ? 'list' : null,
        canPlay: can(CMD.play) || can(CMD.toggle),
        canPause: can(CMD.pause) || can(CMD.toggle),
        canNext: can(CMD.next),
        canPrev: can(CMD.prev),
        canSeek: duration > 0 && can(CMD.seek),
        canShuffle: can(CMD.shuffle),
        canRepeat: can(CMD.repeat)
    });

    const artwork = item ? item.artwork : null;
    const artData = artwork && !artwork.isNil() ? artwork.imageData : null;
    const artLen = artData && !artData.isNil() ? num(artData.length) : 0;
    const thumbKey = trackKey + '|' + artLen;
    if (thumbKey !== lastThumbKey) {
        lastThumbKey = thumbKey;
        const data = artLen > 0 ? ObjC.unwrap(artData.base64EncodedStringWithOptions(0)) : null;
        send({ type: 'thumb', key: thumbKey, mime: data ? (str(md && md.artworkMIMEType) || mimeOf(data)) : null, data });
    }

    return state;
}

makeController();
let nextStateAt = 0;
let emptySince = 0;
while (true) {
    const wait = Math.max(0.01, (nextStateAt - Date.now()) / 1000);
    if (!truthy($.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(wait)))) {
        $.NSThread.sleepForTimeInterval(wait);
    }
    if (stdinClosed) $.exit(0);

    let handled = false;
    while (lines.length) {
        try { handle(lines.shift()); } catch (e) { }
        handled = true;
    }
    if (handled) nextStateAt = Math.min(nextStateAt, Date.now() + 100);
    if (Date.now() < nextStateAt) continue;
    nextStateAt = Date.now() + 400;

    let state;
    try { state = readState(); } catch (e) { state = { type: 'state', active: false, sessions: [], selected: 'auto' }; }

    if (state.active) emptySince = 0;
    else if (!emptySince) emptySince = Date.now();
    else if (Date.now() - emptySince > 15000 && Date.now() - controllerSince > 15000) { makeController(); emptySince = 0; }

    const json = JSON.stringify(state);
    if (json !== lastJson) {
        lastJson = json;
        send(state);
    }
}
`;
