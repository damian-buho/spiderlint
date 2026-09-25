// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

// IANA Well-Known URIs registry suffixes as of 2026-09-25, from https://www.iana.org/assignments/well-known-uris/well-known-uris-1.csv; refreshed by hand.
export const REGISTERED = new Set([
    "acme-challenge", "agent-card.json", "amphtml", "api-catalog", "appspecific", "ashrae", "assetlinks.json", "bluejetty", "broadband-labels",
    "brski", "caldav", "carddav", "change-password", "cmp", "coap", "coap-eap", "core", "csaf", "csaf-aggregator", "csipaus", "csvm",
    "cyclic-trigger", "did.json", "did-configuration.json", "dnt", "dnt-policy.txt", "dots", "easy-proxy", "ecips", "edhoc",
    "enterprise-network-security", "enterprise-transport-security", "est", "funding-manifest-urls", "genid", "gnap-as-rs", "gpc.json", "gs1resolver",
    "hoba", "host-meta", "host-meta.json", "hosting-provider", "http-opportunistic", "ic-domains", "idp-proxy", "jmap", "keybase.txt", "knx",
    "looking-glass", "masque", "matrix", "mercure", "mta-sts.txt", "mud", "nfv-oauth-server-configuration", "ni", "nodeinfo", "nostr.json",
    "oauth-authorization-server", "oauth-protected-resource", "ohttp-gateway", "ojobpub.json", "openbindings", "openid-federation",
    "open-resource-discovery", "openid-configuration", "openorg", "oslc", "pki-validation", "posh", "privacy-sandbox-attestations.json",
    "private-token-issuer-directory", "probing.txt", "pvd", "rd", "related-website-set.json", "reload-config", "repute-template", "resourcesync",
    "sbom", "scitt-keys", "security.txt", "ssf-configuration", "ssh-known-hosts", "sshfp", "stun-key", "tea", "terraform.json", "thread", "time",
    "timezone", "tdmrep.json", "tor-relay", "tpcd", "traffic-advice", "trust.txt", "uma2-configuration", "vacation-rental.json", "void", "webauthn",
    "webfinger", "webhook-authorized-senders.json", "webweaver.json", "wot", "xregistry",
]);
