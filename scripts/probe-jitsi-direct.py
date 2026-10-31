#!/usr/bin/env python3
"""Run on the router: probe Jitsi config.js through marked direct sockets.

Usage: python3 probe-jitsi-direct.py HOST ...
No VPN, system DNS, configuration changes or persistent output files.
"""
import concurrent.futures
import http.client
import json
import os
import socket
import ssl
import struct
import sys
import time


def marked(kind):
    sock = socket.socket(socket.AF_INET, kind)
    sock.settimeout(6)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, 255)
    return sock


def resolve(host):
    ident = os.urandom(2)
    query = ident + b'\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00'
    query += b''.join(bytes([len(x)]) + x.encode('ascii') for x in host.split('.')) + b'\x00\x00\x01\x00\x01'
    with marked(socket.SOCK_DGRAM) as sock:
        sock.connect(('77.88.8.8', 53))
        sock.send(query)
        data = sock.recv(4096)
    if data[:2] != ident or data[3] & 15:
        raise ValueError('DNS: no answer')
    def skip_name(pos):
        while data[pos]:
            if data[pos] & 0xc0 == 0xc0:
                return pos + 2
            pos += 1 + data[pos]
        return pos + 1
    pos = skip_name(12) + 4
    for _ in range(struct.unpack('!H', data[6:8])[0]):
        pos = skip_name(pos)
        kind, _, _, size = struct.unpack('!HHIH', data[pos:pos + 10])
        pos += 10
        if kind == 1 and size == 4:
            return socket.inet_ntoa(data[pos:pos + 4])
        pos += size
    raise ValueError('DNS: no IPv4 address')


def probe(host):
    start = time.monotonic()
    result = {'host': host}
    conn = None
    try:
        ip = resolve(host)
        result['ip'] = ip
        conn = http.client.HTTPSConnection(host, timeout=6)
        sock = marked(socket.SOCK_STREAM)
        try:
            sock.connect((ip, 443))
            conn.sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        except Exception:
            sock.close()
            raise
        conn.request('GET', '/config.js', headers={'User-Agent': 'HomeNet Jitsi diagnostic'})
        response = conn.getresponse()
        body = response.read(1024 * 1024).decode('utf-8', errors='replace')
        result.update(status=response.status, jitsi=response.status == 200 and ('config.hosts' in body or 'hosts:' in body))
    except Exception as error:
        result['error'] = str(error)
    finally:
        if conn:
            conn.close()
    result['ms'] = round((time.monotonic() - start) * 1000)
    return result


if __name__ == '__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for result in pool.map(probe, sys.argv[1:]):
            print(json.dumps(result), flush=True)
