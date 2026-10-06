#!/usr/bin/env python3
"""Extract the koalabeast.com cookies (TagPro's login) from Chrome's profile on macOS.
Uses only built-in Python + macOS system tools (security, openssl). No pip needed.

Usage: extract_chrome_cookies.py [PROFILE]
  PROFILE   a Chrome profile directory name such as "Default" or "Profile 4".
            Without it, every profile is checked and the one holding a live TagPro
            session is used (the most recently used one if several do).

Prints JSON: {"profile": ..., "profileName": ..., "loggedIn": bool, "cookies": [...]}
TagPro sets its session cookie on the parent domain (.koalabeast.com) so that it
also covers the game servers, which is why the whole domain is read, not one host.
"""

import datetime, hashlib, json, os, shutil, sqlite3, subprocess, sys, tempfile

CHROME_DATA    = os.path.expanduser('~/Library/Application Support/Google/Chrome')
TARGET_DOMAIN  = 'koalabeast.com'
SESSION_COOKIE = 'tagpro2'          # present only while logged in


def get_key():
    pw = subprocess.check_output(
        ['security', 'find-generic-password', '-w',
         '-s', 'Chrome Safe Storage', '-a', 'Chrome'],
        stderr=subprocess.DEVNULL,
    ).strip()
    # Chrome macOS key: PBKDF2-SHA1, salt=b'saltysalt', 1003 iterations, 16 bytes
    return hashlib.pbkdf2_hmac('sha1', pw, b'saltysalt', 1003, dklen=16)


def decrypt(enc_bytes, key, host_key):
    b = bytes(enc_bytes)
    if not b:
        return ''
    if b[:3] != b'v10':
        return b.decode('utf-8', errors='replace')
    # AES-128-CBC, IV = 16 space chars (0x20), PKCS7 padding (openssl removes it)
    result = subprocess.run(
        ['openssl', 'enc', '-aes-128-cbc', '-d', '-K', key.hex(), '-iv', '20' * 16, '-nosalt'],
        input=b[3:], capture_output=True,
    )
    if result.returncode != 0:
        return ''
    raw = result.stdout
    # Chrome 127+ prefixes the plaintext with SHA-256(host_key) as an integrity check.
    if len(raw) >= 32 and raw[:32] == hashlib.sha256(host_key.encode()).digest():
        raw = raw[32:]
    return raw.decode('utf-8', errors='replace')


def chrome_time_to_unix(t):
    return (t - 11644473600000000) / 1_000_000 if t > 0 else -1


def profile_label(profile):
    try:
        with open(os.path.join(CHROME_DATA, profile, 'Preferences')) as f:
            return json.load(f).get('profile', {}).get('name', '')
    except Exception:
        return ''


def read_profile(profile, key):
    path = os.path.join(CHROME_DATA, profile, 'Cookies')
    if not os.path.exists(path):
        return None
    tmp = tempfile.mktemp(suffix='.db')
    shutil.copy2(path, tmp)                   # Chrome keeps the live file open
    try:
        conn = sqlite3.connect(f'file:{tmp}?mode=ro', uri=True)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            '''SELECT name, value, encrypted_value, host_key, path,
                      expires_utc, is_secure, is_httponly, samesite
               FROM cookies WHERE host_key LIKE ?''',
            (f'%{TARGET_DOMAIN}',),
        ).fetchall()
        conn.close()
    finally:
        os.unlink(tmp)

    samesite_map = {0: 'Strict', 1: 'Lax', 2: 'None'}
    now = datetime.datetime.now().timestamp()
    cookies = []
    for r in rows:
        expires = chrome_time_to_unix(r['expires_utc'])
        if 0 < expires < now:
            continue                           # expired: Chrome would not send it either
        cookies.append({
            'name':     r['name'],
            'value':    r['value'] or decrypt(r['encrypted_value'], key, r['host_key']),
            'domain':   r['host_key'],
            'path':     r['path'],
            'expires':  expires,
            'secure':   bool(r['is_secure']),
            'httpOnly': bool(r['is_httponly']),
            'sameSite': samesite_map.get(r['samesite'], 'Lax'),
        })
    return {
        'profile':     profile,
        'profileName': profile_label(profile),
        'loggedIn':    any(c['name'] == SESSION_COOKIE for c in cookies),
        'mtime':       os.path.getmtime(path),
        'cookies':     cookies,
    }


def main():
    try:
        key = get_key()
    except Exception as e:
        print(json.dumps({'error': f'Keychain error: {e}', 'cookies': []}))
        return

    wanted = sys.argv[1] if len(sys.argv) > 1 else None
    if wanted:
        result = read_profile(wanted, key)
        if result is None:
            print(json.dumps({'error': f'Cookies not found for Chrome profile "{wanted}"', 'cookies': []}))
            return
    else:
        profiles = [d for d in os.listdir(CHROME_DATA)
                    if os.path.exists(os.path.join(CHROME_DATA, d, 'Cookies'))]
        found = [p for p in (read_profile(d, key) for d in sorted(profiles)) if p]
        logged = [p for p in found if p['loggedIn']]
        pick = max(logged or found or [None], key=lambda p: p['mtime'] if p else 0)
        if pick is None:
            print(json.dumps({'error': f'No Chrome profiles found under {CHROME_DATA}', 'cookies': []}))
            return
        result = pick
    result.pop('mtime', None)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
