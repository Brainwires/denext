#!/bin/bash
# Runs INSIDE a throwaway debian:bookworm-slim container. Produces golden SAML fixtures
# signed by xmlsec1 (libxmlsec1 + OpenSSL), independent of denext's own signer, plus the
# libxml2 `xmllint --exc-c14n` oracle. Regenerate (new throwaway keys every run) with:
#   docker run --rm -v "$PWD/work:/w" debian:bookworm-slim bash /w/generate.sh
# with this script copied into ./work, then copy work/out/* here WITHOUT the *.key files.
set -euo pipefail
set -f
apt-get update -qq >/dev/null && apt-get install -y -qq xmlsec1 openssl libxml2-utils >/dev/null
cd /w
mkdir -p out
# Throwaway test keys (committed: test-only, never trusted anywhere).
openssl req -x509 -newkey rsa:2048 -nodes -keyout out/idp-rsa.key -out out/idp-rsa.crt -days 36500 -subj "/CN=denext SAML test IdP (RSA)" 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out out/idp-ec.key
openssl req -x509 -new -key out/idp-ec.key -out out/idp-ec.crt -days 36500 -subj "/CN=denext SAML test IdP (EC)" 2>/dev/null

sig() { # $1 ref id, $2 sigalg, $3 digestalg, $4 prefixlist ("" = none)
  local inc=""
  if [ -n "$4" ]; then inc="<ec:InclusiveNamespaces xmlns:ec=\"http://www.w3.org/2001/10/xml-exc-c14n#\" PrefixList=\"$4\"/>"; fi
  cat <<EOF
<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
    <ds:SignedInfo>
      <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>
      <ds:SignatureMethod Algorithm="$2"/>
      <ds:Reference URI="#$1">
        <ds:Transforms>
          <ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>
          <ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#">$inc</ds:Transform>
        </ds:Transforms>
        <ds:DigestMethod Algorithm="$3"/>
        <ds:DigestValue/>
      </ds:Reference>
    </ds:SignedInfo>
    <ds:SignatureValue/>
    <ds:KeyInfo><ds:X509Data/></ds:KeyInfo>
  </ds:Signature>
EOF
}
RSA256=http://www.w3.org/2001/04/xmldsig-more#rsa-sha256
RSA512=http://www.w3.org/2001/04/xmldsig-more#rsa-sha512
EC256=http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256
SHA256=http://www.w3.org/2001/04/xmlenc#sha256
SHA512=http://www.w3.org/2001/04/xmlenc#sha512

response() { # $1 response-sig, $2 assertion-sig, $3 "default" to put the Assertion in the default namespace
  local a="saml:" ans=""
  if [ "${3:-}" = default ]; then a=""; ans=' xmlns="urn:oasis:names:tc:SAML:2.0:assertion"'; fi
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:unused="urn:example:unused" ID="_resp1" Version="2.0" IssueInstant="2026-10-13T12:00:00Z" Destination="https://sp.example.com/auth/v1/sso/saml/acs" InResponseTo="_req1">
  <saml:Issuer>https://idp.example.org/metadata</saml:Issuer>
  $1
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <${a}Assertion${ans} ID="_assert1" Version="2.0" IssueInstant="2026-10-13T12:00:00.123Z">
    <${a}Issuer>https://idp.example.org/metadata</${a}Issuer>
    $2
    <${a}Subject>
      <${a}NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">alice@example.com</${a}NameID>
      <${a}SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <${a}SubjectConfirmationData InResponseTo="_req1" NotOnOrAfter="2026-10-13T12:05:00Z" Recipient="https://sp.example.com/auth/v1/sso/saml/acs"/>
      </${a}SubjectConfirmation>
    </${a}Subject>
    <${a}Conditions NotBefore="2026-10-13T11:59:30Z" NotOnOrAfter="2026-10-13T12:05:00Z">
      <${a}AudienceRestriction><${a}Audience>https://sp.example.com/auth/v1/sso/saml/metadata</${a}Audience></${a}AudienceRestriction>
    </${a}Conditions>
    <${a}AuthnStatement AuthnInstant="2026-10-13T12:00:00Z" SessionIndex="_session1" SessionNotOnOrAfter="2026-10-13T20:00:00Z">
      <${a}AuthnContext><${a}AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</${a}AuthnContextClassRef></${a}AuthnContext>
    </${a}AuthnStatement>
    <!-- a comment the digest must not cover -->
    <${a}AttributeStatement>
      <${a}Attribute Name="email" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic"><${a}AttributeValue xsi:type="xs:string">alice@example.com</${a}AttributeValue></${a}Attribute>
      <${a}Attribute Name="groups"><${a}AttributeValue xsi:type="xs:string">admins</${a}AttributeValue><${a}AttributeValue xsi:type="xs:string">R&amp;D &lt;team&gt; "q" &#x9;tab</${a}AttributeValue></${a}Attribute>
      <${a}Attribute Name="display name" FriendlyName="cn"><${a}AttributeValue>Alice Ålesund 𝔄</${a}AttributeValue></${a}Attribute>
    </${a}AttributeStatement>
  </${a}Assertion>
</samlp:Response>
EOF
}
XA="--id-attr:ID urn:oasis:names:tc:SAML:2.0:assertion:Assertion"
XR="--id-attr:ID urn:oasis:names:tc:SAML:2.0:protocol:Response"
NA="--node-xpath //*[local-name()='Assertion']/*[local-name()='Signature']"
NR="--node-xpath /*/*[local-name()='Signature']"

# 1. RSA-SHA256 over the Assertion, PrefixList="xs xsi" (xsi:type values need xs in scope).
response "" "$(sig _assert1 $RSA256 $SHA256 'xs xsi')" > t1.xml
xmlsec1 --sign --privkey-pem out/idp-rsa.key,out/idp-rsa.crt $XA $XR $NA --output out/rsa-assertion-signed.xml t1.xml
# 2. RSA-SHA512 / SHA-512 over the Response only.
response "$(sig _resp1 $RSA512 $SHA512 '')" "" > t2.xml
xmlsec1 --sign --privkey-pem out/idp-rsa.key,out/idp-rsa.crt $XA $XR $NR --output out/rsa-response-signed.xml t2.xml
# 3. Both signed; the Assertion in the default namespace.
response "$(sig _resp1 $RSA256 $SHA256 '')" "$(sig _assert1 $RSA256 $SHA256 'xs xsi')" default > t3.xml
xmlsec1 --sign --privkey-pem out/idp-rsa.key,out/idp-rsa.crt $XA $XR $NA --output t3a.xml t3.xml
xmlsec1 --sign --privkey-pem out/idp-rsa.key,out/idp-rsa.crt $XA $XR $NR --output out/rsa-both-signed.xml t3a.xml
# 4. ECDSA-SHA256 (P-256) over the Assertion.
response "" "$(sig _assert1 $EC256 $SHA256 'xs xsi')" > t4.xml
xmlsec1 --sign --privkey-pem out/idp-ec.key,out/idp-ec.crt $XA $XR $NA --output out/ec-assertion-signed.xml t4.xml
for f in out/*-signed.xml; do
  xmlsec1 --verify --pubkey-cert-pem out/idp-rsa.crt $XA $XR --node-xpath "(//*[local-name()='Signature'])[1]" "$f" >/dev/null 2>&1 && echo "verify-ok-rsa $f" || true
done

# Exclusive c14n oracle (libxml2): whole-document canonical forms.
cat > c14n-in.xml <<'EOF'
<?xml version="1.0"?>
<?pi-before data?>
<!-- comment before -->
<a:root xmlns:a="urn:a" xmlns:b="urn:b" xmlns="urn:default" xmlns:unused="urn:unused" b:z="2" a:y="1" plain='x &lt; y &amp; "z"' tab="a&#9;b&#10;c&#13;d">
  <child attr="v"   other = 'w'>text &amp; &lt;more&gt; &#13; ]&gt;<![CDATA[ <cdata> & ]]></child>
  <b:leaf/>
  <inner xmlns="" xmlns:c="urn:c"><c:deep c:at="q"><none/></c:deep><!-- in --><?pi inner?></inner>
  <a:same xmlns:a="urn:a"><x xmlns="urn:default">é 𝔄</x></a:same>
</a:root>
<!-- comment after -->
EOF
xmllint --exc-c14n c14n-in.xml > out/c14n-exc.txt
xmllint --exc-c14n --nocdata c14n-in.xml > /dev/null || true
cp c14n-in.xml out/c14n-in.xml
chmod -R a+rw out
chown -R 1000:1000 /w
