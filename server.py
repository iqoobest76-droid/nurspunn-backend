"""
nurspunn music backend
"""

import os
import json
import time
import traceback
import threading
import urllib.request
import urllib.error
from flask import Flask, request, jsonify, Response, send_from_directory
import yt_dlp

app = Flask(__name__, static_folder='static', static_url_path='')

_cache = {}
_cache_lock = threading.Lock()
CACHE_TTL = 3600  # 1 hour for stream URLs

COOKIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cookies.txt')


def _cache_get(key):
    with _cache_lock:
        if key in _cache:
            ts, val = _cache[key]
            if time.time() - ts < CACHE_TTL:
                return val
    return None


def _cache_set(key, val):
    with _cache_lock:
        _cache[key] = (time.time(), val)


def _cache_remove(key):
    with _cache_lock:
        _cache.pop(key, None)


# Stream pre-extraction is intentionally disabled on Render's free 512 MB
# instance. Starting ten yt-dlp processes at once makes the service run out of
# memory and then every play request remains on loading.
PREEXTRACT_ENABLED = os.environ.get('PREEXTRACT_ENABLED') == '1'


# Background stream pre-extraction
def _preextract_stream(vid):
    """Extract stream URL in background thread for instant playback later."""
    if _cache_get(f'stream:{vid}'):
        return
    try:
        _extract_stream(vid)
    except Exception:
        pass


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/api/config')
def api_config():
    return jsonify({
        'yt_api_key': os.environ.get('YT_API_KEY', ''),
        'gemini_api_key': os.environ.get('GEMINI_API_KEY', ''),
    })


@app.route('/api/health')
def api_health():
    has_cookies = os.path.exists(COOKIES_FILE)
    return jsonify({
        'status': 'ok',
        'yt_dlp': yt_dlp.version.__version__ if hasattr(yt_dlp, 'version') else 'unknown',
        'cookies': has_cookies,
    })


@app.route('/api/keepalive')
def api_keepalive():
    return jsonify({'status': 'alive', 'time': time.time()})


@app.route('/api/preextract')
def api_preextract():
    """Pre-extract stream URLs for given video IDs in background."""
    if not PREEXTRACT_ENABLED:
        return jsonify({'status': 'disabled'})
    ids = request.args.get('ids', '').strip()
    if not ids:
        return jsonify({'status': 'no ids'})
    vid_list = [v.strip() for v in ids.split(',') if v.strip()][:10]
    for vid in vid_list:
        threading.Thread(target=_preextract_stream, args=(vid,), daemon=True).start()
    return jsonify({'status': 'preextracting', 'count': len(vid_list)})


def _extract_innertube(vid):
    """Direct InnerTube API call — faster than yt-dlp. Returns raw URL from cipher (may need signature)."""
    import urllib.request as req_lib
    clients = [
        {'clientName': 'ANDROID_MUSIC', 'clientVersion': '7.27.52', 'api_key': 'AIzaSyAOghZGza2MQSZkY_zfZ370N-PUdXEo8AI'},
        {'clientName': 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', 'clientVersion': '2.0', 'api_key': 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'},
        {'clientName': 'ANDROID', 'clientVersion': '19.29.37', 'api_key': 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w'},
        {'clientName': 'IOS', 'clientVersion': '19.29.1', 'api_key': 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc'},
        {'clientName': 'WEB_REMIX', 'clientVersion': '1.20250303.00.00', 'api_key': 'AIzaSyC9WL3Uj7IsYDQNTBixLWgWYI2X0I1M3bI'},
    ]
    for cl in clients:
        try:
            body = json.dumps({
                'context': {
                    'client': {
                        'clientName': cl['clientName'],
                        'clientVersion': cl['clientVersion'],
                        'hl': 'en',
                        'gl': 'US',
                    }
                },
                'videoId': vid,
                'contentCheckOk': True,
                'racyCheckOk': True,
            }).encode('utf-8')
            api_url = f'https://www.youtube.com/youtubei/v1/player?key={cl["api_key"]}&prettyPrint=false'
            headers = {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.youtube.com/',
            }
            req = req_lib.Request(api_url, data=body, headers=headers)
            with req_lib.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            ps = data.get('playabilityStatus', {})
            if ps.get('status') in ('ERROR', 'UNPLAYABLE', 'LOGIN_REQUIRED'):
                app.logger.warning('innertube %s status=%s for %s', cl['clientName'], ps.get('status'), vid)
                continue
            streaming = data.get('streamingData', {})
            formats = streaming.get('adaptiveFormats', []) + streaming.get('formats', [])
            audio = [f for f in formats if f.get('mimeType', '').startswith('audio/')]
            if not audio:
                continue
            # Sort by bitrate, prefer mp4a (AAC)
            aac = [f for f in audio if 'mp4a' in f.get('mimeType', '')]
            audio.sort(key=lambda f: f.get('bitrate', 0), reverse=True)
            best = aac[0] if aac else audio[0]
            stream_url = best.get('url') or _extract_url_from_cipher(best.get('signatureCipher') or best.get('cipher', ''))
            if stream_url:
                return {
                    'raw_url': stream_url,
                    'proxy_url': f'/api/proxy?id={vid}',
                    'title': data.get('videoDetails', {}).get('title', ''),
                    'channel': data.get('videoDetails', {}).get('author', ''),
                    'thumbnail': f'https://i.ytimg.com/vi/{vid}/hqdefault.jpg',
                    'duration': data.get('videoDetails', {}).get('lengthSeconds', 0),
                    'strategy': f'innertube_{cl["clientName"]}',
                }
        except Exception as e:
            app.logger.warning('innertube %s failed for %s: %s', cl['clientName'], vid, str(e)[:200])
            continue
    return None


def _extract_url_from_cipher(cipher_str):
    """Extract base URL from signatureCipher/cipher parameter."""
    if not cipher_str:
        return None
    import urllib.parse
    params = urllib.parse.parse_qs(cipher_str)
    return params.get('url', [None])[0]


def _extract_ytdlp(vid):
    """Extract stream URL using yt-dlp as fallback."""
    base_opts = {
        'format': 'bestaudio[ext=m4a]/bestaudio',
        'quiet': True,
        'no_warnings': True,
        'simulate': True,
        'noplaylist': True,
        'nocheckcertificate': True,
        'geo_bypass': True,
        'js_runtimes': {'node': {}},
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.youtube.com/',
        },
    }
    if os.path.exists(COOKIES_FILE):
        base_opts['cookiefile'] = COOKIES_FILE

    strategies = [
        ('default', {}),
        ('android', {'extractor_args': {'youtube': {'player_client': ['android']}}}),
        ('ios', {'extractor_args': {'youtube': {'player_client': ['ios']}}}),
    ]
    for name, extra in strategies:
        try:
            opts = dict(base_opts)
            opts.update(extra)
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(f'https://www.youtube.com/watch?v={vid}', download=False)
            url = info.get('url')
            if not url and info.get('formats'):
                audio_formats = [f for f in info['formats'] if f.get('acodec') != 'none']
                if audio_formats:
                    audio_formats.sort(key=lambda f: (f.get('abr') or f.get('tbr') or 0), reverse=True)
                    url = audio_formats[0].get('url')
            if url:
                return {
                    'raw_url': url,
                    'proxy_url': f'/api/proxy?id={vid}',
                    'title': info.get('title'),
                    'channel': info.get('uploader') or info.get('channel') or '',
                    'thumbnail': info.get('thumbnail') or f'https://i.ytimg.com/vi/{vid}/hqdefault.jpg',
                    'duration': info.get('duration') or 0,
                    'strategy': f'ytdlp_{name}',
                }
        except Exception as e:
            app.logger.warning('ytdlp %s failed for %s: %s', name, vid, str(e)[:200])
            continue
    return None


def _extract_stream(vid):
    """Extract stream URL with caching. Tries InnerTube first, then yt-dlp."""
    cache_key = f'stream:{vid}'
    cached = _cache_get(cache_key)
    if cached:
        return cached
    result = _extract_innertube(vid) or _extract_ytdlp(vid)
    if result:
        _cache_set(cache_key, result)
    return result


@app.route('/api/stream')
def api_stream():
    vid = request.args.get('id', '').strip()
    if not vid:
        return jsonify({'error': 'missing id'}), 400

    result = _extract_stream(vid)
    if result:
        return jsonify(result)

    return jsonify({
        'error': 'Audio is temporarily unavailable. Try another song.',
        'detail': f'all extraction methods failed for {vid}',
    }), 503


@app.route('/api/proxy')
def api_proxy():
    vid = request.args.get('id', '').strip()
    if not vid:
        return jsonify({'error': 'missing id'}), 400

    result = _extract_stream(vid)
    if not result:
        return jsonify({'error': 'could not extract stream'}), 500

    raw_url = result.get('raw_url')
    if not raw_url:
        return jsonify({'error': 'no raw URL'}), 500

    range_header = request.headers.get('Range')

    req_headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.youtube.com/',
        'Origin': 'https://www.youtube.com',
    }
    if range_header:
        req_headers['Range'] = range_header

    try:
        req = urllib.request.Request(raw_url, headers=req_headers)
        resp = urllib.request.urlopen(req, timeout=30)

        status = resp.status
        resp_headers = {
            'Content-Type': 'audio/mp4',
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': 'bytes',
        }
        if resp.headers.get('Content-Length'):
            resp_headers['Content-Length'] = resp.headers['Content-Length']
        if resp.headers.get('Content-Range'):
            resp_headers['Content-Range'] = resp.headers['Content-Range']

        def generate():
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                yield chunk

        return Response(generate(), status=status, headers=resp_headers)
    except urllib.error.HTTPError as e:
        if e.code == 403:
            app.logger.warning('proxy got 403 for %s, retrying with yt-dlp only', vid)
            result = _extract_ytdlp(vid)
            if result and result.get('raw_url'):
                raw_url = result['raw_url']
                req = urllib.request.Request(raw_url, headers=req_headers)
                resp = urllib.request.urlopen(req, timeout=30)
                status = resp.status
                resp_headers = {
                    'Content-Type': 'audio/mp4',
                    'Access-Control-Allow-Origin': '*',
                    'Accept-Ranges': 'bytes',
                }
                if resp.headers.get('Content-Length'):
                    resp_headers['Content-Length'] = resp.headers['Content-Length']
                if resp.headers.get('Content-Range'):
                    resp_headers['Content-Range'] = resp.headers['Content-Range']

                def generate2():
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        yield chunk

                return Response(generate2(), status=status, headers=resp_headers)
        app.logger.error('proxy HTTP error for %s: %s', vid, e)
        return jsonify({'error': str(e)[:200]}), 500
    except Exception as e:
        app.logger.error('proxy failed for %s: %s', vid, e)
        return jsonify({'error': str(e)[:200]}), 500


@app.route('/api/search')
def api_search():
    q = request.args.get('q', '').strip()
    try:
        max_n = int(request.args.get('max', '20'))
    except Exception:
        max_n = 20
    if not q:
        return jsonify({'items': []})
    cache_key = f'search:{q}:{max_n}'
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify({'items': cached, 'source': 'cache'})
    items = []
    try:
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extract_flat': True,
            'noplaylist': True,
            'nocheckcertificate': True,
        }
        if os.path.exists(COOKIES_FILE):
            ydl_opts['cookiefile'] = COOKIES_FILE
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f'ytsearch{max_n}:{q}', download=False)
        entries = info.get('entries', []) or []
        for e in entries:
            vid = e.get('id') or ''
            if not vid:
                continue
            items.append({
                'id': vid,
                'title': e.get('title') or 'Untitled',
                'channel': e.get('channel') or e.get('uploader') or e.get('uploader_id') or '',
                'thumbnail': e.get('thumbnail') or f'https://i.ytimg.com/vi/{vid}/hqdefault.jpg',
                'duration': e.get('duration') or 0,
            })
    except Exception as e:
        app.logger.error('search failed: %s', e)
    _cache_set(cache_key, items)
    # Do not launch yt-dlp work for every result on the free server. The
    # selected song is extracted only when the user actually presses Play.
    if PREEXTRACT_ENABLED:
        for item in items[:2]:
            vid = item.get('id', '')
            if vid:
                threading.Thread(target=_preextract_stream, args=(vid,), daemon=True).start()
    return jsonify({'items': items})


@app.after_request
def after_request(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Range, Content-Type'
    response.headers['Permissions-Policy'] = 'geolocation=(), camera=(), microphone=(), midi=(), gyroscope=(), accelerometer=()'
    return response


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '5000'))
    app.run(host='0.0.0.0', port=port)
