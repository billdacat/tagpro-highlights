#!/usr/bin/env python3
"""Extract tagpro.koalabeast.com cookies from Chrome's profile on macOS.
Uses only built-in Python + macOS system tools (security, openssl). No pip needed.
"""

import hashlib, json, os, shutil, sqlite3, subprocess, sys, tempfile

CHROME_DATA  = os.path.expanduser('~/Library/Application Support/Google/Chrome')
COOKIES_PATH = os.path.join(CHROME_DATA, 'Default', 'Cookies')
TARGET       = 'tagpro.koalabeast.com'

def get_key():
    pw = subprocess.check_output(
        ['security', 'find-generic-password', '-w',
         '-s', 'Chrome Safe Storage', '-a', 'Chrome'],
        stderr=subprocess.DEVNULL,
    ).strip()
    # Chrome macOS key: PBKDF2-SHA1, salt=b'saltysalt', 1003 iterations, 16 bytes
    return hashlib.pbkdf2_hmac('sha1', pw, b'saltysalt', 1003, dklen=16)

def decrypt(enc_bytes, key):
    b = bytes(enc_bytes)
    if not b:
        return ''
    if b[:3] != b'v10':
        return b.decode('utf-8', errors='replace')
    ciphertext = b[3:]
    # AES-128-CBC, IV = 16 space chars (0x20), PKCS7 padding
    result = subprocess.run(
        ['openssl', 'enc', '-aes-128-cbc', '-d',
         '-K', key.hex(),
         '-iv', '20' * 16,
         '-nosalt'],
        input=ciphertext, capture_output=True,
    )
    if result.returncode != 0:
        return ''
    raw = result.stdout
    # Strip PKCS7 padding (openssl should do this, but be safe)
    if raw and 1 <= raw[-1] <= 16:
        raw = raw[:-raw[-1]]
    return raw.decode('utf-8', errors='replace')

def chrome_time_to_unix(t):
    return (t - 11644473600000000) / 1_000_000 if t > 0 else -1

if not os.path.exists(COOKIES_PATH):
    print(json.dumps({'error': f'Cookies not found at {COOKIES_PATH}', 'cookies': []}))
    sys.exit(0)

# Copy DB (Chrome may have it open in WAL mode)
tmp = tempfile.mktemp(suffix='.db')
shutil.copy2(COOKIES_PATH, tmp)

try:
    key = get_key()
except Exception as e:
    os.unlink(tmp)
    print(json.dumps({'error': f'Keychain error: {e}', 'cookies': []}))
    sys.exit(0)

try:
    conn = sqlite3.connect(f'file:{tmp}?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        '''SELECT name, value, encrypted_value, host_key, path,
                  expires_utc, is_secure, is_httponly, samesite
           FROM cookies WHERE host_key LIKE ?''',
        (f'%{TARGET}%',),
    ).fetchall()
    conn.close()
finally:
    os.unlink(tmp)

samesite_map = {0: 'Strict', 1: 'Lax', 2: 'None'}
cookies = []
for r in rows:
    value = r['value'] or decrypt(r['encrypted_value'], key)
    cookies.append({
        'name':     r['name'],
        'value':    value,
        'domain':   TARGET,
        'path':     r['path'],
        'expires':  chrome_time_to_unix(r['expires_utc']),
        'secure':   bool(r['is_secure']),
        'httpOnly': bool(r['is_httponly']),
        'sameSite': samesite_map.get(r['samesite'], 'None'),
    })

print(json.dumps({'cookies': cookies}))
