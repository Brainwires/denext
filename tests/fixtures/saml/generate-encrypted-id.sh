#!/bin/bash
# Runs INSIDE a throwaway debian:bookworm-slim container. Produces golden EncryptedID fixtures
# with xmlsec1 (libxmlsec1 + OpenSSL), independent of denext: the NameID is encrypted in place
# (inside <saml:EncryptedID>) to the committed SP encryption certificate (sp-enc.crt), then the
# Assertion / Response / LogoutRequest is signed over the cipher text by a fresh IdP key. Run:
#   docker run --rm -v "$PWD/work:/w" debian:bookworm-slim bash /w/generate-encrypted-id.sh
# with this script, sp-enc.crt and sp-enc.TEST-ONLY.key copied into ./work, then copy
# work/out/* here. The IdP key is NOT copied (only its certificate).
set -euo pipefail
set -f
apt-get update -qq >/dev/null && apt-get install -y -qq xmlsec1 openssl >/dev/null
cd /w
rm -rf out && mkdir -p out
openssl req -x509 -newkey rsa:2048 -nodes -keyout idp.key -out out/encid-idp.crt -days 36500 -subj "/CN=denext SAML test IdP (EncryptedID)" 2>/dev/null

RSA256=http://www.w3.org/2001/04/xmldsig-more#rsa-sha256
SHA256=http://www.w3.org/2001/04/xmlenc#sha256
sig() { # $1 ref id
  cat <<EOF
<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><ds:SignatureMethod Algorithm="$RSA256"/><ds:Reference URI="#$1"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></ds:Transforms><ds:DigestMethod Algorithm="$SHA256"/><ds:DigestValue/></ds:Reference></ds:SignedInfo><ds:SignatureValue/><ds:KeyInfo><ds:X509Data/></ds:KeyInfo></ds:Signature>
EOF
}

NAMEID='<saml:EncryptedID><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">alice@example.com</saml:NameID></saml:EncryptedID>'

# A Response whose Assertion's Subject carries the NameID inside <saml:EncryptedID>.
response() { # $1 response-sig, $2 assertion-sig
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_resp1" Version="2.0" IssueInstant="2026-10-13T12:00:00Z" Destination="https://sp.example.com/auth/v1/sso/saml/acs" InResponseTo="_req1">
  <saml:Issuer>https://idp.example.org/metadata</saml:Issuer>$1
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <saml:Assertion ID="_assert1" Version="2.0" IssueInstant="2026-10-13T12:00:00Z">
    <saml:Issuer>https://idp.example.org/metadata</saml:Issuer>$2
    <saml:Subject>
      $NAMEID
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData InResponseTo="_req1" NotOnOrAfter="2026-10-13T12:05:00Z" Recipient="https://sp.example.com/auth/v1/sso/saml/acs"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="2026-10-13T11:59:30Z" NotOnOrAfter="2026-10-13T12:05:00Z">
      <saml:AudienceRestriction><saml:Audience>https://sp.example.com/auth/v1/sso/saml/metadata</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="2026-10-13T12:00:00Z" SessionIndex="_session1"/>
  </saml:Assertion>
</samlp:Response>
EOF
}

enc_template() { # $1 content alg
  cat <<EOF
<xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#" Type="http://www.w3.org/2001/04/xmlenc#Element"><xenc:EncryptionMethod Algorithm="$1"/><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><xenc:EncryptedKey><xenc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p"><ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/></xenc:EncryptionMethod><xenc:CipherData><xenc:CipherValue/></xenc:CipherData></xenc:EncryptedKey></ds:KeyInfo><xenc:CipherData><xenc:CipherValue/></xenc:CipherData></xenc:EncryptedData>
EOF
}

XA="--id-attr:ID urn:oasis:names:tc:SAML:2.0:assertion:Assertion"
XR="--id-attr:ID urn:oasis:names:tc:SAML:2.0:protocol:Response"
XL="--id-attr:ID urn:oasis:names:tc:SAML:2.0:protocol:LogoutRequest"
NA="--node-xpath //*[local-name()='Assertion']/*[local-name()='Signature']"
NR="--node-xpath /*/*[local-name()='Signature']"
NAMEID_XPATH="--node-xpath //*[local-name()='EncryptedID']/*[local-name()='NameID']"
GCM=http://www.w3.org/2009/xmlenc11#aes256-gcm
CBC=http://www.w3.org/2001/04/xmlenc#aes128-cbc
enc_template $GCM > tgcm.xml
enc_template $CBC > tcbc.xml

# 1. NameID encrypted AES-256-GCM, then the Assertion signed over the EncryptedID.
response "" "$(sig _assert1)" > a1.xml
xmlsec1 --encrypt --pubkey-cert-pem sp-enc.crt --session-key aes-256 --xml-data a1.xml $NAMEID_XPATH --output a1e.xml tgcm.xml
xmlsec1 --sign --privkey-pem idp.key,out/encid-idp.crt $XA $XR $NA --output out/encid-gcm-assertion-signed.xml a1e.xml

# 2. NameID encrypted AES-128-CBC, unsigned Assertion, the Response signed.
response "$(sig _resp1)" "" > a2.xml
xmlsec1 --encrypt --pubkey-cert-pem sp-enc.crt --session-key aes-128 --xml-data a2.xml $NAMEID_XPATH --output a2e.xml tcbc.xml
xmlsec1 --sign --privkey-pem idp.key,out/encid-idp.crt $XA $XR $NR --output out/encid-cbc-response-signed.xml a2e.xml

# 3. An IdP-initiated LogoutRequest over HTTP-POST: NameID encrypted AES-256-GCM, then signed.
cat > l1.xml <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_logout1" Version="2.0" IssueInstant="2026-10-13T12:00:00Z" Destination="https://sp.example.com/auth/v1/sso/saml/slo" NotOnOrAfter="2026-10-13T12:05:00Z">
  <saml:Issuer>https://idp.example.org/metadata</saml:Issuer>$(sig _logout1)
  $NAMEID
  <samlp:SessionIndex>_session1</samlp:SessionIndex>
</samlp:LogoutRequest>
EOF
xmlsec1 --encrypt --pubkey-cert-pem sp-enc.crt --session-key aes-256 --xml-data l1.xml $NAMEID_XPATH --output l1e.xml tgcm.xml
xmlsec1 --sign --privkey-pem idp.key,out/encid-idp.crt $XL $NR --output out/encid-slo-request-post-signed.xml l1e.xml

for f in out/encid-*.xml; do
  xmlsec1 --decrypt --privkey-pem sp-enc.TEST-ONLY.key --output /dev/null "$f" >/dev/null 2>&1 && echo "decrypt-ok $f"
done
xmlsec1 --verify --pubkey-cert-pem out/encid-idp.crt $XA $XR --node-xpath "//*[local-name()='Assertion']/*[local-name()='Signature']" out/encid-gcm-assertion-signed.xml >/dev/null 2>&1 && echo "verify-ok gcm"
xmlsec1 --verify --pubkey-cert-pem out/encid-idp.crt $XA $XR $NR out/encid-cbc-response-signed.xml >/dev/null 2>&1 && echo "verify-ok cbc"
xmlsec1 --verify --pubkey-cert-pem out/encid-idp.crt $XL out/encid-slo-request-post-signed.xml >/dev/null 2>&1 && echo "verify-ok slo"
chmod -R a+rw out
chown -R 1000:1000 /w
