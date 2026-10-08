"""Generate tests/fixtures/qr-reference.ts's symbols with two independent QR encoders.

segno picks the version and (unless forced) the mask; python-qrcode rebuilds each symbol at
that version + mask and must agree module for module. Prints the JSON array the fixture holds.
"""
import segno, json, base64, qrcode
import segno.encoder as _enc
from qrcode.util import QRData, MODE_8BIT_BYTE
from qrcode.constants import ERROR_CORRECT_L, ERROR_CORRECT_M, ERROR_CORRECT_Q, ERROR_CORRECT_H
# segno 1.6.6 adds a whole 0x00 codeword when the terminator already ends on a codeword
# boundary; ISO/IEC 18004 7.4.10 adds padding bits only when it does not.
_enc.write_padding_bits = lambda buff, version, length: buff.extend([0] * ((8 - length % 8) % 8))
lv={'L':ERROR_CORRECT_L,'M':ERROR_CORRECT_M,'Q':ERROR_CORRECT_Q,'H':ERROR_CORRECT_H}
uri="otpauth://totp/Acme:ada%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Acme&algorithm=SHA1&digits=6&period=30"
uri2="otpauth://totp/denext:7f3c2a1e-0b9d-4c55-8e21-9a7b6c5d4e3f?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=denext&algorithm=SHA1&digits=6&period=30"
cases=[]
spec=[ # text, ecc, version(None=auto), mask(None=auto)
 ("a","L",None,None),("a","M",None,None),("a","Q",None,None),("a","H",None,None),
 ("HELLO WORLD","Q",1,None),
 ("https://denext.dev","M",None,0),("https://denext.dev","M",None,1),("https://denext.dev","M",None,2),("https://denext.dev","M",None,3),
 ("https://denext.dev","M",None,4),("https://denext.dev","M",None,5),("https://denext.dev","M",None,6),("https://denext.dev","M",None,7),
 (uri,"L",None,None),(uri,"M",None,None),(uri,"Q",None,None),(uri,"H",None,None),
 (uri2,"M",None,None),(uri2,"H",None,None),
 ("Grüße, 漢字 — ünïcödé","M",None,None),
 ("x"*150,"M",None,None),("y"*213,"M",10,None),("z"*271,"Q",None,None),
 ("q"*400,"H",None,None),("w"*1000,"M",32,None),("e"*2953,"L",40,None),("r"*1273,"H",40,None),
]
for text,e,v,m in spec:
    q=segno.make_qr(text, error=e, mode='byte', boost_error=False, encoding='utf-8', version=v, mask=m)
    rows=[[1 if b else 0 for b in r] for r in q.matrix]
    # second, independent encoder at segno's version + mask
    q2=qrcode.QRCode(version=q.version, error_correction=lv[e], mask_pattern=q.mask, border=0)
    q2.add_data(QRData(text.encode('utf-8'), mode=MODE_8BIT_BYTE)); q2.make(fit=False)
    rows2=[[1 if b else 0 for b in r] for r in q2.modules]
    assert rows==rows2, (text[:20],e,q.version,q.mask)
    bits=[b for r in rows for b in r]
    packed=bytearray((len(bits)+7)//8)
    for i,b in enumerate(bits):
        if b: packed[i>>3] |= 0x80>>(i&7)
    cases.append(dict(text=text,ecc=e,version=v,mask=m,expectVersion=q.version,expectMask=q.mask,modules=base64.b64encode(bytes(packed)).decode()))
print(json.dumps(cases))
