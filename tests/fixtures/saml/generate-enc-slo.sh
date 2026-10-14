#!/bin/bash
# Runs INSIDE a throwaway debian:bookworm-slim container. Produces golden fixtures for encrypted
# assertions and Single Logout with tools independent of denext: xmlsec1 (libxmlsec1 + OpenSSL)
# signs and encrypts the XML, Python's zlib DEFLATEs the HTTP-Redirect messages and
# `openssl dgst -sign` signs their query strings. Regenerate (new throwaway keys every run) with:
#   docker run --rm -v "$PWD/work:/w" debian:bookworm-slim bash /w/generate-enc-slo.sh
# with this script copied into ./work, then copy work/out/* here. The IdP key is NOT copied
# (only its certificate); the SP keys are committed as sp-*.TEST-ONLY.key — test-only keys the
# verifier needs to decrypt the fixtures, trusted nowhere.
set -euo pipefail
set -f
apt-get update -qq >/dev/null && apt-get install -y -qq xmlsec1 openssl python3-minimal >/dev/null
cd /w
rm -rf out && mkdir -p out
openssl req -x509 -newkey rsa:2048 -nodes -keyout idp.key -out out/enc-idp.crt -days 36500 -subj "/CN=denext SAML test IdP (encryption and logout)" 2>/dev/null
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out out/sp-enc.TEST-ONLY.key 2>/dev/null
openssl req -x509 -new -key out/sp-enc.TEST-ONLY.key -out out/sp-enc.crt -days 36500 -subj "/CN=denext SAML test SP encryption (TEST ONLY)" 2>/dev/null
xmlsec1 --version > out/xmlsec1-version.txt

RSA256=http://www.w3.org/2001/04/xmldsig-more#rsa-sha256
SHA256=http://www.w3.org/2001/04/xmlenc#sha256
sig() { # $1 ref id, $2 prefixlist ("" = none)
  local inc=""
  if [ -n "$2" ]; then inc="<ec:InclusiveNamespaces xmlns:ec=\"http://www.w3.org/2001/10/xml-exc-c14n#\" PrefixList=\"$2\"/>"; fi
  cat <<EOF
<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><ds:SignatureMethod Algorithm="$RSA256"/><ds:Reference URI="#$1"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#">$inc</ds:Transform></ds:Transforms><ds:DigestMethod Algorithm="$SHA256"/><ds:DigestValue/></ds:Reference></ds:SignedInfo><ds:SignatureValue/><ds:KeyInfo><ds:X509Data/></ds:KeyInfo></ds:Signature>
EOF
}

# A Response whose one Assertion sits inside <saml:EncryptedAssertion> (to be encrypted in place).
response() { # $1 response-sig, $2 assertion-sig
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_resp1" Version="2.0" IssueInstant="2026-10-13T12:00:00Z" Destination="https://sp.example.com/auth/v1/sso/saml/acs" InResponseTo="_req1">
  <saml:Issuer>https://idp.example.org/metadata</saml:Issuer>$1
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <saml:EncryptedAssertion><saml:Assertion ID="_assert1" Version="2.0" IssueInstant="2026-10-13T12:00:00Z">
    <saml:Issuer>https://idp.example.org/metadata</saml:Issuer>$2
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">alice@example.com</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData InResponseTo="_req1" NotOnOrAfter="2026-10-13T12:05:00Z" Recipient="https://sp.example.com/auth/v1/sso/saml/acs"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="2026-10-13T11:59:30Z" NotOnOrAfter="2026-10-13T12:05:00Z">
      <saml:AudienceRestriction><saml:Audience>https://sp.example.com/auth/v1/sso/saml/metadata</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="2026-10-13T12:00:00Z" SessionIndex="_session1"/>
    <saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>alice@example.com</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>
  </saml:Assertion></saml:EncryptedAssertion>
</samlp:Response>
EOF
}

enc_template() { # $1 content alg, $2 key transport method (inner XML of EncryptionMethod)
  cat <<EOF
<xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#" Type="http://www.w3.org/2001/04/xmlenc#Element"><xenc:EncryptionMethod Algorithm="$1"/><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><xenc:EncryptedKey>$2<xenc:CipherData><xenc:CipherValue/></xenc:CipherData></xenc:EncryptedKey></ds:KeyInfo><xenc:CipherData><xenc:CipherValue/></xenc:CipherData></xenc:EncryptedData>
EOF
}

XA="--id-attr:ID urn:oasis:names:tc:SAML:2.0:assertion:Assertion"
XR="--id-attr:ID urn:oasis:names:tc:SAML:2.0:protocol:Response"
NA="--node-xpath //*[local-name()='Assertion']/*[local-name()='Signature']"
NR="--node-xpath /*/*[local-name()='Signature']"
ASSERTION="--node-xpath //*[local-name()='Assertion']"

# 1. Signed Assertion, encrypted AES-256-GCM + RSA-OAEP (mgf1p, SHA-1), unsigned Response.
response "" "$(sig _assert1 '')" > e1.xml
xmlsec1 --sign --privkey-pem idp.key,out/enc-idp.crt $XA $XR $NA --output e1s.xml e1.xml
enc_template http://www.w3.org/2009/xmlenc11#aes256-gcm \
  '<xenc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p"><ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/></xenc:EncryptionMethod>' > t1.xml
xmlsec1 --encrypt --pubkey-cert-pem out/sp-enc.crt --session-key aes-256 --xml-data e1s.xml $ASSERTION --output out/enc-gcm-assertion-signed.xml t1.xml

# 2. Unsigned Assertion, encrypted AES-128-CBC + RSA-OAEP (mgf1p), then the Response signed
#    over the EncryptedAssertion.
response "$(sig _resp1 '')" "" > e2.xml
enc_template http://www.w3.org/2001/04/xmlenc#aes128-cbc \
  '<xenc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p"/>' > t2.xml
xmlsec1 --encrypt --pubkey-cert-pem out/sp-enc.crt --session-key aes-128 --xml-data e2.xml $ASSERTION --output e2e.xml t2.xml
xmlsec1 --sign --privkey-pem idp.key,out/enc-idp.crt $XR $NR --output out/enc-cbc-response-signed.xml e2e.xml

# 3. An IdP-initiated LogoutRequest over HTTP-POST, enveloped-signed.
cat > l1.xml <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_logout1" Version="2.0" IssueInstant="2026-10-13T12:00:00Z" Destination="https://sp.example.com/auth/v1/sso/saml/slo" NotOnOrAfter="2026-10-13T12:05:00Z">
  <saml:Issuer>https://idp.example.org/metadata</saml:Issuer>$(sig _logout1 '')
  <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">alice@example.com</saml:NameID>
  <samlp:SessionIndex>_session1</samlp:SessionIndex>
</samlp:LogoutRequest>
EOF
xmlsec1 --sign --privkey-pem idp.key,out/enc-idp.crt --id-attr:ID urn:oasis:names:tc:SAML:2.0:protocol:LogoutRequest $NR --output out/slo-request-post-signed.xml l1.xml

# 4. HTTP-Redirect: the same kind of messages, DEFLATEd by Python and their query strings signed
#    by `openssl dgst -sha256 -sign` (SAML Bindings 3.4.4.1).
cat > l2.xml <<'EOF'
<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_logout2" Version="2.0" IssueInstant="2026-10-13T12:00:00Z" Destination="https://sp.example.com/auth/v1/sso/saml/slo"><saml:Issuer>https://idp.example.org/metadata</saml:Issuer><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">alice@example.com</saml:NameID><samlp:SessionIndex>_session1</samlp:SessionIndex></samlp:LogoutRequest>
EOF
cat > l3.xml <<'EOF'
<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_logoutresp1" Version="2.0" IssueInstant="2026-10-13T12:00:00Z" Destination="https://sp.example.com/auth/v1/sso/saml/slo" InResponseTo="_spreq1"><saml:Issuer>https://idp.example.org/metadata</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status></samlp:LogoutResponse>
EOF
cat > redirect.py <<'EOF'
import base64, subprocess, sys, urllib.parse, zlib
param, path, relay, key, out = sys.argv[1:6]
xml = open(path, "rb").read().strip()
c = zlib.compressobj(9, zlib.DEFLATED, -15)
deflated = c.compress(xml) + c.flush()
q = lambda v: urllib.parse.quote(v, safe="")
octets = f"{param}={q(base64.b64encode(deflated).decode())}"
if relay:
    octets += f"&RelayState={q(relay)}"
octets += f"&SigAlg={q('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256')}"
sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", key], input=octets.encode(),
                     capture_output=True, check=True).stdout
open(out, "w").write(f"?{octets}&Signature={q(base64.b64encode(sig).decode())}\n")
EOF
python3 redirect.py SAMLRequest l2.xml "relay-1" idp.key out/slo-request-redirect.txt
python3 redirect.py SAMLResponse l3.xml "relay-2" idp.key out/slo-response-redirect.txt

for f in out/enc-gcm-assertion-signed.xml out/enc-cbc-response-signed.xml; do
  xmlsec1 --decrypt --privkey-pem out/sp-enc.TEST-ONLY.key --output /dev/null "$f" >/dev/null 2>&1 && echo "decrypt-ok $f"
done
xmlsec1 --verify --pubkey-cert-pem out/enc-idp.crt --id-attr:ID urn:oasis:names:tc:SAML:2.0:protocol:LogoutRequest out/slo-request-post-signed.xml >/dev/null 2>&1 && echo "verify-ok slo-request-post-signed.xml"
chmod -R a+rw out
chown -R 1000:1000 /w
