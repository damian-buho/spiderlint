// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createPublicKey, X509Certificate } from "node:crypto";
import { isIP, Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { MxData } from "dns-packet";
import { Parser } from "htmlparser2";
import { getDomain } from "tldts";
import type { DnsClient, Reply } from "../crawl/dns.ts";
import { reason } from "../crawl/fetch.ts";
import { log } from "../logger.ts";
import type { RuleSpec } from "../rules/types.ts";
import { MAIL_RULES, records, texts, warnOnce, zoneOf } from "./dns.ts";
import { definePlugin, type SiteContext, type SiteExtractor } from "./types.ts";

// `org.spiderlint.mail`: `mode` overrides the derived one, `dkim-selectors` adds to the probed list, `dane` and `starttls` opt in.
interface MailSettings {
    mode: "auto" | "mail" | "none";
    "dkim-selectors": string[];
    dane: boolean;
    starttls: boolean;
}

// Selectors common enough to probe, since DNS cannot list them.
const SELECTORS = ["default", "dkim", "mail", "selector1", "selector2", "google", "k1", "s1", "s2", "fm1", "fm2", "fm3", "protonmail", "protonmail2", "protonmail3"];

// A mail provider’s MX suffix and the selectors it signs with.
const PROVIDERS: [RegExp, string[]][] = [
    [/\.zoho\.(com|eu|in)\.?$/i, ["zmail", "zoho"]],
    [/\.mailgun\.org\.?$/i, ["mailo", "smtp", "mg"]],
    [/\.mailbox\.org\.?$/i, ["MBO0001", "MBO0002"]],
    [/\.migadu\.com\.?$/i, ["key1", "key2", "key3"]],
    [/\.icloud\.com\.?$/i, ["sig1"]],
    [/\.yandex\.(net|ru)\.?$/i, ["mail"]],
];

// DNS-querying SPF terms RFC 7208 §4.6.4 allows, void lookups, and the walk’s own cap.
const SPF_LOOKUPS = 10;
const SPF_WALK = 30;

// Longest MTA-STS `max_age` RFC 8461 §3.2 allows.
const MAX_AGE = 31_557_600;

const SMTP_MS = 8000;

const DMARC_POLICIES = new Set(["none", "quarantine", "reject"]);

type Parsed = { tags: Map<string, string>; errors: string[] };

// `tag=value` pairs split on `;`, duplicates and malformed pairs as errors; `first` must lead with `version`.
function tagList(record: string, first: string, version: RegExp): Parsed {
    const tags = new Map<string, string>();
    const errors: string[] = [];
    const parts = record.split(";").map((part) => part.trim()).filter(Boolean);
    for (const [index, part] of parts.entries()) {
        const match = /^([a-z][a-z0-9_]*)\s*=\s*(.*)$/is.exec(part);
        if (!match) errors.push(`malformed tag “${part}”`);
        else if (tags.has((match[1] as string).toLowerCase())) errors.push(`duplicate tag ${match[1]}`);
        else tags.set((match[1] as string).toLowerCase(), (match[2] as string).trim());
        if (index === 0 && (match?.[1]?.toLowerCase() !== first || !version.test(match[2] ?? ""))) errors.push(`does not begin with ${first}=`);
    }
    return { tags, errors };
}

// A domain-spec with `%{d}` and `%{o}` filled; undefined when a sender macro is left, since no sender is known.
function expand(spec: string, domain: string): string | undefined {
    const filled = spec.replaceAll(/%\{[do]r?\}/gi, () => domain).replaceAll("%%", "%").replaceAll("%_", " ").replaceAll("%-", "%20");
    return filled.includes("%") ? undefined : filled.replace(/\.$/, "");
}

// Whether a reply is a void lookup: NXDOMAIN, or NOERROR with no answer (RFC 7208 §4.6.4).
function isVoid(reply: Reply): boolean {
    return reply.rcode === "NXDOMAIN" || (reply.rcode === "NOERROR" && reply.answers.length === 0);
}

interface Term {
    text: string;
    qualifier: string;
    name: string;
    value?: string;
    modifier: boolean;
}

// One SPF term split into qualifier, name and argument, with its grammar errors (RFC 7208 §12).
function spfTerm(text: string, errors: string[]): Term {
    const modifier = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(text);
    if (modifier) {
        const name = (modifier[1] as string).toLowerCase();
        const value = modifier[2] as string;
        if (!value && ["redirect", "exp"].includes(name)) errors.push(`${name}= names no domain`);
        if (/%(?![{%_-])/.test(value)) errors.push(`bad macro in ${text}`);
        return { text, qualifier: "", name, value, modifier: true };
    }
    const match = /^([+\-~?]?)([a-z0-9]+)(.*)$/i.exec(text);
    const qualifier = match?.[1] ?? "";
    const name = (match?.[2] ?? text).toLowerCase();
    const rest = match?.[3] ?? "";
    const isPrefix = (value: string | undefined, most: number) => value === undefined || (/^\d{1,3}$/.test(value) && Number(value) <= most);
    const ip = (family: 4 | 6) => {
        const [, address = "", prefix] = /^:([^/]+)(?:\/(.*))?$/.exec(rest) ?? [];
        return isIP(address) === family && isPrefix(prefix, family === 4 ? 32 : 128);
    };
    const target = /^:([^/\s]+)$/.exec(rest)?.[1];
    const validators: Record<string, () => boolean> = {
        all: () => rest === "",
        include: () => target !== undefined,
        exists: () => target !== undefined,
        ptr: () => rest === "" || target !== undefined,
        a: () => /^(?::[^/\s]+)?(?:\/(\d{1,2}))?(?:\/\/(\d{1,3}))?$/.test(rest) && isPrefix(/\/(\d+)(?:\/\/|$)/.exec(rest)?.[1], 32) && isPrefix(/\/\/(\d+)$/.exec(rest)?.[1], 128),
        ip4: () => ip(4),
        ip6: () => ip(6),
    };
    validators.mx = validators.a as () => boolean;
    const validate = validators[name];
    if (validate === undefined) errors.push(`unknown mechanism ${text}`);
    else if (!validate()) errors.push(`malformed ${text}`);
    const value = rest.startsWith(":") ? rest.slice(1).split("/", 1)[0] : undefined;
    return { text, qualifier, name, ...(value && { value }), modifier: false };
}

// The terms of one `v=spf1` record, with the grammar errors found on the way.
function spfTerms(record: string): { terms: Term[]; errors: string[] } {
    const errors: string[] = [];
    const [version, ...rest] = record.trim().split(/ +/);
    if (version?.toLowerCase() !== "v=spf1") errors.push("does not begin with v=spf1");
    const terms = rest.map((text) => spfTerm(text, errors));
    for (const name of ["redirect", "exp"]) if (terms.filter((term) => term.modifier && term.name === name).length > 1) errors.push(`${name}= appears twice`);
    return { terms, errors };
}

interface Walk {
    lookups: number;
    voids: number;
    ptr: boolean;
    missing: string[];
    seen: Set<string>;
}

// The SPF record of `domain`, when exactly one is published.
async function spfOf(domain: string, dns: DnsClient, walk: Walk): Promise<string | undefined> {
    const reply = await dns.query(domain, "TXT");
    const found = texts(reply).filter((entry) => /^v=spf1(\s|$)/i.test(entry));
    if (isVoid(reply)) walk.voids += 1;
    if (found.length !== 1) walk.missing.push(domain);
    return found.length === 1 ? found[0] : undefined;
}

// Counts the DNS-querying terms up to `all` of `record` and of every record it includes or redirects to, within the walk’s cap.
async function spfWalk(domain: string, record: string, dns: DnsClient, walk: Walk): Promise<void> {
    walk.seen.add(domain.toLowerCase());
    const { terms } = spfTerms(record);
    const hasAll = terms.some((term) => term.name === "all");
    for (const term of terms) {
        if (walk.lookups >= SPF_WALK) return log.debug({ domain, lookups: walk.lookups }, "spf walk capped");
        if (term.name === "all" && !term.modifier) return log.debug({ domain, lookups: walk.lookups }, "spf walk reached all");
        const isQuerying = term.modifier ? term.name === "redirect" && !hasAll : ["include", "a", "mx", "ptr", "exists"].includes(term.name);
        if (!isQuerying) continue;
        walk.lookups += 1;
        if (term.name === "ptr") walk.ptr = true;
        const target = expand(term.value ?? domain, domain);
        log.debug({ domain, term: term.text, target, lookups: walk.lookups }, "spf term counted");
        if (!target || term.name === "ptr") continue;
        if (term.name === "include" || term.name === "redirect") {
            if (walk.seen.has(target.toLowerCase())) continue;
            const next = await spfOf(target, dns, walk);
            if (next) await spfWalk(target, next, dns, walk);
        } else if (isVoid(await dns.query(target, term.name === "mx" ? "MX" : "A"))) walk.voids += 1;
    }
}

// The one SPF record’s grammar, lookups, void lookups, `ptr`, terms after `all`, repeated terms and missing includes.
async function spfCheck(domain: string, record: string, dns: DnsClient): Promise<Record<string, unknown>> {
    const { terms, errors } = spfTerms(record);
    const walk: Walk = { lookups: 0, voids: 0, ptr: false, missing: [], seen: new Set() };
    await spfWalk(domain, record, dns, walk);
    const mechanisms = terms.filter((term) => !term.modifier);
    const allAt = mechanisms.findIndex((term) => term.name === "all");
    const keys = mechanisms.map((term) => term.text.toLowerCase().replace(/^\+/, ""));
    const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
    const ignored = allAt === -1 ? [] : terms.filter((term) => term.modifier && term.name === "redirect").map((term) => term.text);
    const result = { errors, lookups: walk.lookups, "void-lookups": walk.voids, ptr: walk.ptr, "after-all": allAt === -1 ? [] : mechanisms.slice(allAt + 1).map((term) => term.text), redundant: [...new Set([...repeated, ...ignored])], "missing-includes": walk.missing };
    log.debug({ domain, ...result }, "spf walked");
    return result;
}

// The DMARC records at `_dmarc.<name>`.
async function dmarcRecords(name: string, dns: DnsClient): Promise<string[]> {
    return texts(await dns.query(`_dmarc.${name}`, "TXT")).filter((entry) => /^v\s*=\s*DMARC1\s*(;|$)/i.test(entry));
}

// The DMARC record at the host, else at its organisational domain, with the policy that applies to the host (RFC 9989 §4.10).
export async function dmarc(host: string, dns: DnsClient): Promise<{ at: string; record: string; policy?: string; count: number } | undefined> {
    const names = new Set([host, getDomain(host, { allowPrivateDomains: true }) ?? host]);
    for (const name of names) {
        const found = await dmarcRecords(name, dns);
        log.debug({ host, name, found: found.length }, "dmarc looked up");
        const record = found[0];
        if (!record) continue;
        const tags = new Map(record.split(";").map((tag) => tag.split("=", 2).map((part) => part.trim().toLowerCase()) as [string, string]));
        const policy = name === host ? tags.get("p") : (tags.get("sp") ?? tags.get("p"));
        return { at: name, record, ...(policy && { policy }), count: found.length };
    }
}

// The grammar of a DMARC record by RFC 9989 §4.7, `pct` read as the legacy tag older receivers still honour.
function dmarcTags(record: string): Parsed {
    const parsed = tagList(record, "v", /^DMARC1$/);
    const check = (tag: string, isValid: (value: string) => boolean) => {
        const value = parsed.tags.get(tag);
        if (value !== undefined && !isValid(value.toLowerCase())) parsed.errors.push(`bad ${tag}=${value}`);
    };
    for (const tag of ["p", "sp", "np"]) check(tag, (value) => DMARC_POLICIES.has(value));
    for (const tag of ["adkim", "aspf"]) check(tag, (value) => ["r", "s"].includes(value));
    check("t", (value) => ["y", "n"].includes(value));
    check("psd", (value) => ["y", "n", "u"].includes(value));
    check("fo", (value) => /^[01ds](:[01ds])*$/.test(value));
    check("pct", (value) => /^\d{1,3}$/.test(value) && Number(value) <= 100);
    for (const tag of ["rua", "ruf"]) check(tag, (value) => value.split(",").every((uri) => URL.canParse(uri.trim().replace(/!\d+[kmgt]?$/, ""))));
    return parsed;
}

// The report URIs of one tag, without a size limit suffix.
function reportUris(tags: Map<string, string>): string[] {
    return ["rua", "ruf"].flatMap((tag) => (tags.get(tag) ?? "").split(",").map((uri) => uri.trim().replace(/!\d+[kmgt]?$/i, "")).filter(Boolean));
}

// A DMARC record’s grammar, testing state, subdomain policy, non-mailto report URIs and external destinations that do not accept its reports (RFC 9990 §4).
async function dmarcCheck(subject: string, found: { at: string; record: string; count: number }, pages: readonly SiteContext["pages"][number][], dns: DnsClient): Promise<Record<string, unknown>> {
    const { tags, errors } = dmarcTags(found.record);
    const uris = reportUris(tags);
    const notMailto = uris.filter((uri) => !/^mailto:[^@\s]+@[^@\s]+$/i.test(uri));
    const organisation = getDomain(found.at, { allowPrivateDomains: true }) ?? found.at;
    const destinations = [...new Set(uris.flatMap((uri) => (/^mailto:[^@]+@(.+)$/i.exec(uri)?.[1] ?? "").toLowerCase().split(/[?]/, 1)).filter((host) => host && getDomain(host, { allowPrivateDomains: true }) !== organisation))];
    const unauthorized: string[] = [];
    for (const destination of destinations) {
        const isAuthorized = texts(await dns.query(`${found.at}._report._dmarc.${destination}`, "TXT")).some((entry) => /^v\s*=\s*DMARC1\s*(;|$)/i.test(entry));
        log.debug({ subject, at: found.at, destination, isAuthorized }, "external dmarc destination checked");
        if (!isAuthorized) unauthorized.push(destination);
    }
    const subdomains = found.at === subject && pages.some((page) => new URL(page.url.href).hostname.endsWith(`.${subject}`));
    const pct = tags.get("pct");
    return { records: found.count, errors, testing: tags.get("t")?.toLowerCase() === "y" || (pct !== undefined && pct !== "100"), ...(found.at === subject && { subdomains }), ...(tags.has("sp") && { sp: tags.get("sp")?.toLowerCase() }), "not-mailto": notMailto, unauthorized };
}

// The grammar, key type, key size, testing flag and revocation of one DKIM key record (RFC 6376 §3.6.1).
function dkimKey(selector: string, record: string): Record<string, unknown> {
    const { tags, errors } = tagList(record.startsWith("v=") ? record : `v=DKIM1; ${record}`, "v", /^DKIM1$/);
    const k = (tags.get("k") ?? "rsa").toLowerCase();
    const p = (tags.get("p") ?? "").replaceAll(/\s/g, "");
    if (!tags.has("p")) errors.push("no p= tag");
    if (!["rsa", "ed25519"].includes(k)) errors.push(`unknown k=${k}`);
    let bits: number | undefined;
    if (p && k === "rsa") {
        try {
            bits = createPublicKey({ key: Buffer.from(p, "base64"), format: "der", type: "spki" }).asymmetricKeyDetails?.modulusLength;
        } catch (error) {
            errors.push(`p= is not an RSA public key: ${reason(error)}`);
        }
    }
    const flags = (tags.get("t") ?? "").toLowerCase().split(":").map((flag) => flag.trim());
    return { selector, errors, k, ...(bits !== undefined && { bits }), testing: flags.includes("y"), revoked: tags.has("p") && p === "" };
}

// Each probed selector that publishes a key, from the pinned list, the MX provider’s and the configured ones.
async function dkimCheck(domain: string, exchanges: string[], extra: string[], dns: DnsClient): Promise<Record<string, unknown>> {
    const provided = PROVIDERS.filter(([pattern]) => exchanges.some((exchange) => pattern.test(exchange))).flatMap(([, selectors]) => selectors);
    const selectors = [...new Set([...SELECTORS, ...provided, ...extra])];
    const found = await Promise.all(selectors.map(async (selector) => [selector, texts(await dns.query(`${selector}._domainkey.${domain}`, "TXT")).join("")] as const));
    const keys = found.filter(([, record]) => record).map(([selector, record]) => dkimKey(selector, record));
    log.debug({ domain, probed: selectors.length, provided, found: keys.map((key) => key.selector) }, "dkim selectors probed");
    return { probed: selectors.length, found: keys };
}

// Each exchange: its CNAME target, whether it is an address literal, and how many addresses it resolves to; and repeated exchanges.
async function exchangeCheck(exchanges: string[], dns: DnsClient): Promise<{ exchanges: Record<string, unknown>[]; duplicates: string[] }> {
    const names = exchanges.map((exchange) => exchange.toLowerCase().replace(/\.$/, ""));
    const checked = await Promise.all(
        [...new Set(names)].map(async (exchange) => {
            const isLiteral = isIP(exchange.replaceAll(/^\[|\]$/g, "")) !== 0;
            if (isLiteral) return { exchange, cname: false, literal: true };
            const [a, aaaa] = await Promise.all([dns.query(exchange, "A"), dns.query(exchange, "AAAA")]);
            const cname = records<string>(a, "CNAME").find((record) => record.name.toLowerCase().replace(/\.$/, "") === exchange)?.data ?? false;
            return { exchange, cname, literal: false, addresses: records(a, "A").length + records(aaaa, "AAAA").length };
        }),
    );
    const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
    log.debug({ exchanges: checked, duplicates }, "mail exchanges checked");
    return { exchanges: checked, duplicates };
}

// Whether an MTA-STS `mx` pattern covers an exchange: exact, or `*.` for one leftmost label (RFC 8461 §4.1).
function isCovered(pattern: string, exchange: string): boolean {
    const [want, name] = [pattern.toLowerCase().replace(/\.$/, ""), exchange.toLowerCase().replace(/\.$/, "")];
    return want.startsWith("*.") ? name.split(".").slice(1).join(".") === want.slice(2) && name.split(".").length === want.split(".").length : want === name;
}

// The `_mta-sts` record and, when it parses, the policy file at `mta-sts.<domain>` with the exchanges it does not cover (RFC 8461 §3).
async function mtaStsCheck(domain: string, exchanges: string[], context: SiteContext): Promise<Record<string, unknown>> {
    const found = texts(await context.dns.query(`_mta-sts.${domain}`, "TXT")).filter((entry) => /^v\s*=\s*STSv1\s*(;|$)/i.test(entry));
    if (found.length === 0) return {};
    const { tags, errors } = tagList(found[0] as string, "v", /^STSv1$/);
    if (found.length > 1) errors.push(`${found.length} records`);
    if (!/^[A-Za-z0-9]{1,32}$/.test(tags.get("id") ?? "")) errors.push("id= is not 1 to 32 letters and digits");
    if (errors.length > 0) return { record: found[0], errors };
    const url = `https://mta-sts.${domain}/.well-known/mta-sts.txt`;
    const policy: Record<string, unknown> & { errors: string[] } = { url, errors: [] };
    try {
        const answer = await context.delegated(url, { method: "GET", redirect: "manual" });
        const type = String([answer.headers["content-type"] ?? ""].flat()[0]);
        policy.status = answer.status;
        if (answer.status !== 200) policy.errors.push(`answers ${answer.status}`);
        if (!/^text\/plain\b/i.test(type)) policy.errors.push(`served as ${type || "no type"}`);
        const fields = answer.body.split(/\r?\n/).map((line) => /^([a-z_]+):\s*(.*?)\s*$/i.exec(line)).filter((match) => match !== null);
        const one = (key: string) => fields.find((match) => match[1] === key)?.[2];
        const patterns = fields.filter((match) => match[1] === "mx").map((match) => match[2] as string);
        const [version, mode, maxAge] = [one("version"), one("mode"), one("max_age")];
        if (version !== "STSv1") policy.errors.push(`version is ${version ?? "missing"}`);
        if (!["enforce", "testing", "none"].includes(mode ?? "")) policy.errors.push(`mode is ${mode ?? "missing"}`);
        if (!/^\d{1,10}$/.test(maxAge ?? "") || Number(maxAge) > MAX_AGE) policy.errors.push(`max_age is ${maxAge ?? "missing"}`);
        if (mode !== "none" && patterns.length === 0) policy.errors.push("no mx line");
        Object.assign(policy, { mode, mx: patterns, "max-age": Number(maxAge), unmatched: mode === "none" ? [] : exchanges.filter((exchange) => patterns.every((pattern) => !isCovered(pattern, exchange))) });
    } catch (error) {
        policy.errors.push(reason(error));
    }
    log.debug({ domain, url, errors: policy.errors, mode: policy.mode, unmatched: policy.unmatched }, "mta-sts policy read");
    return { record: found[0], errors, policy };
}

// The `_smtp._tls` reporting record and its grammar (RFC 8460 §3).
async function tlsRptCheck(domain: string, dns: DnsClient): Promise<Record<string, unknown>> {
    const found = texts(await dns.query(`_smtp._tls.${domain}`, "TXT")).filter((entry) => /^v\s*=\s*TLSRPTv1\s*(;|$)/i.test(entry));
    if (found.length === 0) return {};
    const { tags, errors } = tagList(found[0] as string, "v", /^TLSRPTv1$/);
    if (found.length > 1) errors.push(`${found.length} records`);
    const uris = (tags.get("rua") ?? "").split(",").map((uri) => uri.trim()).filter(Boolean);
    if (uris.length === 0) errors.push("no rua=");
    for (const uri of uris) if (!/^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/i.test(uri)) errors.push(`rua ${uri} is neither mailto: nor https:`);
    log.debug({ domain, errors }, "tls-rpt read");
    return { record: found[0], errors };
}

// SVG Tiny PS profile errors of a BIMI logo: its root, a title, no script and no external reference.
function svgErrors(body: string): string[] {
    const errors: string[] = [];
    let root: { name: string; attributes: Record<string, string> } | undefined;
    let hasTitle = false;
    const parser = new Parser(
        {
            onopentag(name, attributes) {
                root ??= { name, attributes };
                if (name === "title") hasTitle = true;
                else if (name === "script" || name === "foreignobject") errors.push(`<${name}> is not allowed`);
                for (const [key, value] of Object.entries(attributes)) {
                    if (/^on/i.test(key)) errors.push(`${key} is an event handler`);
                    else if (/^(xlink:)?href$/i.test(key) && !value.startsWith("#")) errors.push(`${key} ${value} is an external reference`);
                }
            },
        },
        { xmlMode: true },
    );
    parser.end(body);
    if (root?.name !== "svg") return ["not an SVG document"];
    const { version, baseProfile } = root.attributes;
    if (version !== "1.2") errors.push(`version is ${version ?? "missing"}, not 1.2`);
    if (baseProfile?.toLowerCase() !== "tiny-ps") errors.push(`baseProfile is ${baseProfile ?? "missing"}, not tiny-ps`);
    for (const key of ["x", "y"]) if (Object.hasOwn(root.attributes, key)) errors.push(`the root carries ${key}=`);
    if (!hasTitle) errors.push("no <title>");
    return errors;
}

// One GET through `delegated`, its status and body, or the error it failed with.
async function fetched(url: string, context: SiteContext): Promise<{ status?: number; body?: string; error?: string }> {
    try {
        const answer = await context.delegated(url, { method: "GET", redirect: "follow" });
        return { status: answer.status, body: answer.body };
    } catch (error) {
        return { error: reason(error) };
    }
}

// The `default._bimi` record, its grammar, whether DMARC enforces, the logo’s SVG profile and whether the VMC parses.
async function bimiCheck(domain: string, isEnforced: boolean, context: SiteContext): Promise<Record<string, unknown> | undefined> {
    const found = texts(await context.dns.query(`default._bimi.${domain}`, "TXT")).filter((entry) => /^v\s*=\s*BIMI1\s*(;|$)/i.test(entry));
    if (found.length === 0) return;
    const { tags, errors } = tagList(found[0] as string, "v", /^BIMI1$/);
    const [logo, vmc] = [tags.get("l") ?? "", tags.get("a") ?? ""];
    if (logo && !/^https:\/\/\S+$/i.test(logo)) errors.push(`l= ${logo} is not an https URL`);
    if (vmc && !/^https:\/\/\S+$/i.test(vmc)) errors.push(`a= ${vmc} is not an https URL`);
    const result: Record<string, unknown> = { record: found[0], errors, "dmarc-enforced": isEnforced };
    if (logo && errors.length === 0) {
        const answer = await fetched(logo, context);
        result.logo = { url: logo, errors: answer.error ? [answer.error] : answer.status === 200 ? svgErrors(answer.body ?? "") : [`answers ${answer.status}`] };
    }
    if (vmc && errors.length === 0) {
        const answer = await fetched(vmc, context);
        const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(answer.body ?? "")?.[0];
        let isParsed = false;
        try {
            isParsed = pem !== undefined && new X509Certificate(pem).subject !== "";
        } catch (error) {
            log.debug({ domain, vmc, error: reason(error) }, "vmc does not parse");
        }
        result.vmc = { url: vmc, status: answer.status, parses: isParsed };
    }
    log.debug({ domain, errors, isEnforced, logo: result.logo, vmc: result.vmc }, "bimi read");
    return result;
}

// Each exchange’s `_25._tcp` TLSA records and whether the resolver validated them (RFC 7672 §2.2).
async function daneCheck(exchanges: string[], dns: DnsClient): Promise<Record<string, unknown>[]> {
    return Promise.all(
        exchanges.map(async (exchange) => {
            const reply = await dns.query(`_25._tcp.${exchange}`, "TLSA");
            const result = { exchange, tlsa: records(reply, "TLSA").length, signed: reply.ad };
            log.debug(result, "dane read");
            return result;
        }),
    );
}

// The reverse DNS name of an address.
function reverseName(address: string): string {
    if (isIP(address) === 4) return `${address.split(".").toReversed().join(".")}.in-addr.arpa`;
    const [head = "", tail = ""] = address.split("::", 2);
    const [left, right] = [head ? head.split(":") : [], tail ? tail.split(":") : []];
    const groups = address.includes("::") ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right] : left;
    return `${groups.map((group) => group.padStart(4, "0")).join("").split("").toReversed().join(".")}.ip6.arpa`;
}

// The SMTP reply lines up to the last of one reply, which has a space after its code.
function smtpReply(socket: Socket): Promise<string[]> {
    return new Promise((resolve, reject) => {
        let buffer = "";
        const onData = (chunk: Buffer) => {
            buffer += chunk.toString("latin1");
            const lines = buffer.split("\r\n").filter(Boolean);
            if (!/^\d{3} /m.test(buffer) || !buffer.endsWith("\r\n")) return;
            socket.off("data", onData);
            resolve(lines);
        };
        socket.on("data", onData);
        socket.once("error", reject);
        socket.once("close", () => reject(new Error("connection closed")));
    });
}

// The banner, STARTTLS offer, negotiated protocol and certificate validity of one exchange on port 25.
async function starttls(exchange: string, address: string, signal: AbortSignal): Promise<{ banner: string; offered: boolean; protocol?: string; authorized?: boolean }> {
    const socket = new Socket();
    const abort = AbortSignal.any([signal, AbortSignal.timeout(SMTP_MS)]);
    const stop = () => socket.destroy(new Error(`port 25 of ${address} gave no answer in time`));
    abort.addEventListener("abort", stop, { once: true });
    try {
        await new Promise<void>((resolve, reject) => socket.once("error", reject).connect(25, address, resolve));
        const [banner = ""] = await smtpReply(socket);
        socket.write("EHLO spiderlint.invalid\r\n");
        const extensions = await smtpReply(socket);
        const offered = extensions.some((line) => /^250[- ]STARTTLS\b/i.test(line));
        if (!offered) return { banner, offered };
        socket.write("STARTTLS\r\n");
        const ready = await smtpReply(socket);
        if (!ready[0]?.startsWith("220")) return { banner, offered };
        const secure = await new Promise<{ protocol?: string; authorized: boolean }>((resolve, reject) => {
            const tls = tlsConnect({ socket, servername: exchange, rejectUnauthorized: false }, () => {
                resolve({ protocol: tls.getProtocol() ?? undefined, authorized: tls.authorized });
                tls.end("QUIT\r\n");
            });
            tls.once("error", reject);
        });
        return { banner, offered, ...secure };
    } finally {
        abort.removeEventListener("abort", stop);
        socket.destroy();
    }
}

// Each exchange’s port 25 answer and the PTR names of its address; one warning per run when the port does not answer.
async function starttlsCheck(exchanges: string[], context: SiteContext): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    for (const exchange of exchanges) {
        try {
            const address = await context.address(exchange);
            const ptr = records<string>(await context.dns.query(reverseName(address), "PTR"), "PTR").map(({ data }) => data.toLowerCase().replace(/\.$/, ""));
            const answer = await starttls(exchange, address, context.signal);
            const name = (/^220[ -](\S+)/.exec(answer.banner)?.[1] ?? "").toLowerCase().replace(/\.$/, "");
            const result = { exchange, address, ...answer, ptr, "banner-matches": ptr.includes(name) };
            log.debug(result, "starttls probed");
            results.push(result);
        } catch (error) {
            warnOnce(context.dns, "SMTP port 25", { exchange, error: reason(error) });
        }
    }
    return results;
}

// Whether an SPF record lets some host send: a mechanism with no `-`, `~` or `?` qualifier, or a `redirect=`.
const isAuthorizing = (record: string): boolean => record.split(/\s+/).slice(1).some((term) => /^\+?(all$|a\b|mx\b|ptr\b|ip4:|ip6:|include:|exists:)|^redirect=/i.test(term));

// MX, SPF and DMARC of one host or registrable domain, the `intent` its MX and SPF declare and the `mode` it is judged in; a mail name adds every authentication record.
const mail: SiteExtractor = {
    id: "mail",
    per: "host",
    domains: true,
    cached: false,
    resolves: true,
    timeout: 120_000,
    async extract(host, context) {
        const settings = (context.settings ?? {}) as Partial<MailSettings>;
        const zone = await zoneOf(host, context.dns);
        if (!zone) return;
        const [mx, txt, policy] = await Promise.all([context.dns.query(host, "MX"), context.dns.query(host, "TXT"), dmarc(host, context.dns)]);
        const exchanges = records<MxData>(mx, "MX").map(({ data }) => ({ preference: data.preference ?? 0, exchange: data.exchange }));
        const spf = texts(txt).filter((entry) => /^v=spf1(\s|$)/i.test(entry));
        const receives = exchanges.some(({ exchange }) => exchange !== ".");
        const sends = spf.some((record) => isAuthorizing(record));
        const intent = sends ? (receives ? "both" : "sends") : receives ? "receives" : "none";
        const mode = settings.mode && settings.mode !== "auto" ? settings.mode : intent === "none" ? "none" : "mail";
        log.debug({ host, zone, mx: exchanges.length, spf: spf.length, dmarc: policy?.policy, intent, mode, configured: settings.mode ?? "auto" }, "mail mode decided");
        const { count: _count, ...found } = policy ?? { count: 0 };
        const base = { mx: exchanges, spf, ...(policy && { dmarc: found }), intent, mode };
        if (mode === "none") return base;
        const real = exchanges.map(({ exchange }) => exchange).filter((exchange) => exchange !== ".");
        const checkedDmarc = policy && (await dmarcCheck(host, policy, context.pages, context.dns));
        const dmarcFacts = checkedDmarc && { ...found, ...checkedDmarc };
        const isEnforced = ["quarantine", "reject"].includes(policy?.policy ?? "") && checkedDmarc?.testing === false;
        const [walk, dkim, checked, mtaSts, tlsRpt, bimi, dane, smtp] = await Promise.all([
            spf.length === 1 ? spfCheck(host, spf[0] as string, context.dns) : undefined,
            dkimCheck(host, real, settings["dkim-selectors"] ?? [], context.dns),
            exchangeCheck(real, context.dns),
            mtaStsCheck(host, real, context),
            tlsRptCheck(host, context.dns),
            bimiCheck(host, isEnforced, context),
            settings.dane ? daneCheck(real, context.dns) : undefined,
            settings.starttls ? starttlsCheck(real, context) : undefined,
        ]);
        return { ...base, ...(dmarcFacts && { dmarc: dmarcFacts }), ...(walk && { "spf-walk": walk }), dkim, ...checked, "mta-sts": mtaSts, "tls-rpt": tlsRpt, ...(bimi && { bimi }), ...(dane && { dane }), ...(smtp && { starttls: smtp }) };
    },
};

// Guards a rule to names judged as mail names, and to facts present only for some.
const MAIL = { "site.hosts.*.mail.mode": "mail" };
const present = (path: string, type = "object"): Record<string, unknown> => ({ ...MAIL, [`site.hosts.*.mail.${path}`]: { type } });
const clean = (path: string): Record<string, unknown> => ({ ...present(path), [`site.hosts.*.mail.${path}.errors`]: { maxItems: 0 } });

const RULES: Record<string, RuleSpec> = {
    "mail/spf-syntax": {
        fact: "site.hosts.*.mail.spf-walk.errors",
        when: present("spf-walk"),
        expect: { maxItems: 0 },
        message: "the SPF record breaks the RFC 7208 grammar, so receivers treat it as a permanent error and ignore it (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc7208#section-12",
        fix: "Rewrite the TXT record at Name `{host}` as `v=spf1`, then mechanisms such as `mx ip4:192.0.2.1 include:_spf.example.net`, then `-all`, separated by single spaces.",
    },
    "mail/spf-lookups": {
        fact: "site.hosts.*.mail.spf-walk.lookups",
        when: clean("spf-walk"),
        expect: { maximum: SPF_LOOKUPS },
        message: "SPF needs {got} DNS lookups counting its includes, over the 10 RFC 7208 allows, so receivers fail it",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc7208#section-4.6.4",
        fix: "Cut the `include`, `a`, `mx`, `ptr` and `exists` terms of the SPF record at Name `{host}` to at most 10 lookups, replacing includes with the `ip4:` and `ip6:` ranges they name.",
    },
    "mail/spf-void-lookups": {
        fact: "site.hosts.*.mail.spf-walk.void-lookups",
        when: clean("spf-walk"),
        expect: { maximum: 2 },
        message: "SPF makes {got} lookups that find nothing, over the 2 RFC 7208 allows, so receivers fail it",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc7208#section-4.6.4",
        fix: "Delete the terms of the SPF record at Name `{host}` that name domains with no record, such as an `include:` of a provider you left.",
    },
    "mail/spf-ptr": {
        fact: "site.hosts.*.mail.spf-walk.ptr",
        when: clean("spf-walk"),
        expect: { const: false },
        message: "SPF uses the ptr mechanism, which RFC 7208 says not to use, since it is slow and unreliable",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc7208#section-5.5",
        fix: "Replace `ptr` in the SPF record at Name `{host}` with the `ip4:` and `ip6:` ranges of the servers it matched.",
    },
    "mail/spf-after-all": {
        fact: "site.hosts.*.mail.spf-walk.after-all",
        when: clean("spf-walk"),
        expect: { maxItems: 0 },
        message: "SPF lists mechanisms after all, which receivers never reach (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc7208#section-5.1",
        fix: "Move every mechanism of the SPF record at Name `{host}` before its `all`, such as `v=spf1 mx include:_spf.example.net -all`.",
    },
    "mail/spf-redundant": {
        fact: "site.hosts.*.mail.spf-walk.redundant",
        when: clean("spf-walk"),
        expect: { maxItems: 0 },
        message: "SPF repeats a mechanism, or carries a redirect that all makes unreachable (got {got})",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc7208#section-6.1",
        fix: "Delete the repeated terms from the SPF record at Name `{host}`, and drop `redirect=` where the record ends in `all`.",
    },
    "mail/spf-include": {
        fact: "site.hosts.*.mail.spf-walk.missing-includes",
        when: clean("spf-walk"),
        expect: { maxItems: 0 },
        message: "SPF includes or redirects to a name with no single SPF record, a permanent error to receivers (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc7208#section-5.2",
        fix: "Delete the `include:` or `redirect=` of the SPF record at Name `{host}` that names no SPF record, or correct its spelling.",
    },
    "mail/dmarc-record": {
        fact: "site.hosts.*.mail.dmarc.records",
        when: present("dmarc"),
        expect: { maximum: 1 },
        message: "the name publishes {got} DMARC records, so receivers discard all of them",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc9989#section-4.10",
        fix: "Keep one TXT record with Content starting `v=DMARC1` at Name `_dmarc.{domain}`, merging the others into it.",
    },
    "mail/dmarc-syntax": {
        fact: "site.hosts.*.mail.dmarc.errors",
        when: present("dmarc"),
        expect: { maxItems: 0 },
        message: "the DMARC record breaks the RFC 9989 grammar (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc9989#section-4.7",
        fix: "Rewrite the TXT record at Name `_dmarc.{domain}` as tag=value pairs after `v=DMARC1`, such as `v=DMARC1; p=reject; rua=mailto:dmarc@{domain}`.",
    },
    "mail/dmarc-subdomains": {
        fact: "site.hosts.*.mail.dmarc",
        when: { ...clean("dmarc"), "site.hosts.*.mail.dmarc.subdomains": true },
        expect: { required: ["sp"] },
        message: "the DMARC record sets no sp= policy although the domain serves subdomains, which then inherit p= silently",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc9989#section-4.7",
        fix: "Add `sp=reject`, or the policy the subdomains need, to the TXT record at Name `_dmarc.{domain}`.",
    },
    "mail/dmarc-testing": {
        fact: "site.hosts.*.mail.dmarc.testing",
        when: clean("dmarc"),
        expect: { const: false },
        message: "the DMARC policy is in test mode, t=y or pct below 100, so receivers do not apply it to all mail",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc9989#section-4.7",
        fix: "Remove `t=y` and `pct=` from the TXT record at Name `_dmarc.{domain}` once its reports show only your own servers.",
    },
    "mail/dmarc-report-uri": {
        fact: "site.hosts.*.mail.dmarc.not-mailto",
        when: clean("dmarc"),
        expect: { maxItems: 0 },
        message: "a DMARC report address is not a mailto: URI, so no report reaches it (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc9990#section-3",
        fix: "Write each `rua=` and `ruf=` address in the TXT record at Name `_dmarc.{domain}` as `mailto:dmarc@{domain}`.",
    },
    "mail/dmarc-external": {
        fact: "site.hosts.*.mail.dmarc.unauthorized",
        when: clean("dmarc"),
        expect: { maxItems: 0 },
        message: "DMARC sends reports to a domain that does not accept them, so receivers drop them (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc9990#section-4",
        fix: "Ask the report destination to publish a TXT record at Name `{domain}._report._dmarc.<destination>` with Content `v=DMARC1`, or report to an address under `{domain}`.",
    },
    "mail/dkim": {
        fact: "site.hosts.*.mail.dkim.found",
        when: present("dkim"),
        expect: { minItems: 1 },
        message: "no DKIM key found under any common selector; the probe list cannot be complete, so check your provider’s selector",
        severity: "hint",
        docs: "https://www.rfc-editor.org/rfc/rfc6376#section-3.6.2.1",
        fix: "Publish the DKIM key your mail provider gives as a TXT record at Name `<selector>._domainkey.{domain}`, and list its selector under `org.spiderlint.mail.dkim-selectors`.",
    },
    "mail/dkim-syntax": {
        fact: "site.hosts.*.mail.dkim.found",
        when: present("dkim"),
        expect: { items: { properties: { errors: { maxItems: 0 } } } },
        message: "a DKIM key record breaks the RFC 6376 grammar, so signatures under it fail (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc6376#section-3.6.1",
        fix: "Republish the TXT record at Name `<selector>._domainkey.{domain}` exactly as your mail provider gives it, `v=DKIM1; k=rsa; p=` and the base64 key.",
    },
    "mail/dkim-key": {
        fact: "site.hosts.*.mail.dkim.found",
        when: present("dkim"),
        expect: { items: { properties: { bits: { minimum: 1024 } } } },
        message: "a DKIM RSA key is shorter than the 1024 bits RFC 8301 requires, so receivers treat its signatures as absent (got {got})",
        severity: "error",
        docs: "https://www.rfc-editor.org/rfc/rfc8301#section-3.2",
        fix: "Generate a 2048-bit DKIM key at your mail provider and publish it at a new selector under `_domainkey.{domain}`.",
    },
    "mail/dkim-key-size": {
        fact: "site.hosts.*.mail.dkim.found",
        when: present("dkim"),
        expect: { items: { properties: { bits: { not: { minimum: 1024, maximum: 2047 } } } } },
        message: "a DKIM RSA key is shorter than 2048 bits, which RFC 8301 recommends (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc8301#section-3.2",
        fix: "Generate a 2048-bit DKIM key at your mail provider and publish it at a new selector under `_domainkey.{domain}`.",
    },
    "mail/dkim-testing": {
        fact: "site.hosts.*.mail.dkim.found",
        when: present("dkim"),
        expect: { items: { properties: { testing: { const: false } } } },
        message: "a DKIM key still carries the t=y testing flag, so receivers may ignore failed signatures (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc6376#section-3.6.1",
        fix: "Remove `t=y` from the TXT record at Name `<selector>._domainkey.{domain}`.",
    },
    "mail/dkim-revoked": {
        fact: "site.hosts.*.mail.dkim.found",
        when: present("dkim"),
        expect: { items: { properties: { revoked: { const: false } } } },
        message: "a DKIM selector publishes an empty key, which revokes it; fine for a retired selector, not for one in use (got {got})",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc6376#section-3.6.1",
        fix: "Delete the TXT record at Name `<selector>._domainkey.{domain}` once no mail signed with it is in transit.",
    },
    "mail/mx-resolves": {
        fact: "site.hosts.*.mail.exchanges",
        when: present("exchanges", "array"),
        expect: { items: { properties: { addresses: { minimum: 1 } } } },
        message: "an MX exchange has no A or AAAA record, so mail to it bounces (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc5321#section-5.1",
        fix: "Add A and AAAA records for the Mail server the MX record of `{host}` names, or point the MX at a server that has them.",
    },
    "mail/mx-cname": {
        fact: "site.hosts.*.mail.exchanges",
        when: present("exchanges", "array"),
        expect: { items: { properties: { cname: { const: false } } } },
        message: "an MX exchange is a CNAME, which RFC 2181 forbids and some senders refuse (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc2181#section-10.3",
        fix: "Set the Mail server of the MX record of `{host}` to the CNAME’s target, the name that has the A and AAAA records.",
    },
    "mail/mx-literal": {
        fact: "site.hosts.*.mail.exchanges",
        when: present("exchanges", "array"),
        expect: { items: { properties: { literal: { const: false } } } },
        message: "an MX exchange is an IP address, not a name, so senders cannot use it (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc7505#section-3",
        fix: "Give the mail server a name with an A record, such as `mx.{domain}`, and set it as the Mail server of the MX record of `{host}`.",
    },
    "mail/mx-duplicate": {
        fact: "site.hosts.*.mail.duplicates",
        when: present("duplicates", "array"),
        expect: { maxItems: 0 },
        message: "the MX set names an exchange more than once (got {got})",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc5321#section-5.1",
        fix: "Delete the repeated MX records of `{host}`, keeping one per Mail server.",
    },
    "mail/mta-sts": {
        fact: "site.hosts.*.mail.mta-sts",
        when: present("mta-sts"),
        expect: { required: ["record"] },
        message: "no MTA-STS record, so senders deliver over STARTTLS that an attacker on the path can strip",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc8461",
        fix: "Serve `version: STSv1`, `mode: enforce`, one `mx:` line per Mail server and `max_age: 604800` at `https://mta-sts.{domain}/.well-known/mta-sts.txt`, then add a TXT record at Name `_mta-sts.{domain}` with Content `v=STSv1; id=20260101`.",
    },
    "mail/mta-sts-syntax": {
        fact: "site.hosts.*.mail.mta-sts.errors",
        when: present("mta-sts"),
        expect: { maxItems: 0 },
        message: "the _mta-sts record breaks the RFC 8461 grammar, so senders ignore the policy (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc8461#section-3.1",
        fix: "Keep one TXT record at Name `_mta-sts.{domain}` with Content `v=STSv1; id=20260101`, the id letters and digits only.",
    },
    "mail/mta-sts-policy": {
        fact: "site.hosts.*.mail.mta-sts.policy.errors",
        when: { ...present("mta-sts"), "site.hosts.*.mail.mta-sts.policy": { type: "object" } },
        expect: { maxItems: 0 },
        message: "the MTA-STS policy file does not answer 200 as text/plain or does not parse, so senders ignore it (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc8461#section-3.2",
        fix: "Serve `https://mta-sts.{domain}/.well-known/mta-sts.txt` with status 200 as `text/plain`, carrying `version: STSv1`, `mode: enforce`, one `mx:` line per Mail server and `max_age: 604800`.",
    },
    "mail/mta-sts-mode": {
        fact: "site.hosts.*.mail.mta-sts.policy.mode",
        when: { ...present("mta-sts"), "site.hosts.*.mail.mta-sts.policy.errors": { maxItems: 0 } },
        expect: { const: "enforce" },
        message: "the MTA-STS policy is in {got} mode, so senders still deliver when TLS fails",
        severity: "hint",
        docs: "https://www.rfc-editor.org/rfc/rfc8461#section-5",
        fix: "Set `mode: enforce` in `https://mta-sts.{domain}/.well-known/mta-sts.txt` once TLS reports show no failures, and change the id of the TXT record at Name `_mta-sts.{domain}`.",
    },
    "mail/mta-sts-mx": {
        fact: "site.hosts.*.mail.mta-sts.policy.unmatched",
        when: { ...present("mta-sts"), "site.hosts.*.mail.mta-sts.policy.errors": { maxItems: 0 } },
        expect: { maxItems: 0 },
        message: "the MTA-STS policy covers no mx: pattern for an exchange, so enforcing senders refuse to deliver to it (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc8461#section-4.1",
        fix: "Add an `mx:` line for every Mail server of `{host}` to `https://mta-sts.{domain}/.well-known/mta-sts.txt`, and change the id of the TXT record at Name `_mta-sts.{domain}`.",
    },
    "mail/mta-sts-max-age": {
        fact: "site.hosts.*.mail.mta-sts.policy.max-age",
        when: { ...present("mta-sts"), "site.hosts.*.mail.mta-sts.policy.errors": { maxItems: 0 } },
        expect: { minimum: 86_400 },
        message: "the MTA-STS max_age is {got} seconds, under a day, so senders forget the policy between messages",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc8461#section-3.2",
        fix: "Set `max_age: 604800` or more in `https://mta-sts.{domain}/.well-known/mta-sts.txt`.",
    },
    "mail/tls-rpt": {
        fact: "site.hosts.*.mail.tls-rpt",
        when: present("tls-rpt"),
        expect: { required: ["record"] },
        message: "no TLS-RPT record, so senders cannot report failed TLS deliveries",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc8460",
        fix: "Add a TXT record at Name `_smtp._tls.{domain}` with Content `v=TLSRPTv1; rua=mailto:tls-reports@{domain}`.",
    },
    "mail/tls-rpt-syntax": {
        fact: "site.hosts.*.mail.tls-rpt.errors",
        when: present("tls-rpt"),
        expect: { maxItems: 0 },
        message: "the TLS-RPT record breaks the RFC 8460 grammar (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc8460#section-3",
        fix: "Keep one TXT record at Name `_smtp._tls.{domain}` with Content `v=TLSRPTv1; rua=mailto:tls-reports@{domain}`.",
    },
    "mail/bimi-syntax": {
        fact: "site.hosts.*.mail.bimi.errors",
        when: present("bimi"),
        expect: { maxItems: 0 },
        message: "the BIMI record breaks its grammar (got {got})",
        severity: "warning",
        docs: "https://datatracker.ietf.org/doc/draft-brand-indicators-for-message-identification/",
        fix: "Keep one TXT record at Name `default._bimi.{domain}` with Content `v=BIMI1; l=https://{domain}/logo.svg; a=https://{domain}/vmc.pem`.",
    },
    "mail/bimi-dmarc": {
        fact: "site.hosts.*.mail.bimi.dmarc-enforced",
        when: present("bimi"),
        expect: { const: true },
        message: "BIMI is published but DMARC does not quarantine or reject all mail, so no receiver shows the logo",
        severity: "warning",
        docs: "https://datatracker.ietf.org/doc/draft-brand-indicators-for-message-identification/",
        fix: "Set `p=quarantine` or `p=reject` without `t=y` or `pct=` in the TXT record at Name `_dmarc.{domain}`.",
    },
    "mail/bimi-logo": {
        fact: "site.hosts.*.mail.bimi.logo.errors",
        when: { ...present("bimi"), "site.hosts.*.mail.bimi.logo": { type: "object" } },
        expect: { maxItems: 0 },
        message: "the BIMI logo does not load or breaks the SVG Tiny PS profile, so receivers show none (got {got})",
        severity: "warning",
        docs: "https://datatracker.ietf.org/doc/draft-svg-tiny-ps-abrotman/",
        fix: "Serve the logo the `l=` tag names as an SVG with `version=\"1.2\" baseProfile=\"tiny-ps\"`, a `<title>`, no script and no external reference.",
    },
    "mail/bimi-vmc": {
        fact: "site.hosts.*.mail.bimi.vmc.parses",
        when: { ...present("bimi"), "site.hosts.*.mail.bimi.vmc": { type: "object" } },
        expect: { const: true },
        message: "the BIMI certificate the a= tag names does not load or is not a PEM certificate",
        severity: "warning",
        docs: "https://datatracker.ietf.org/doc/draft-brand-indicators-for-message-identification/",
        fix: "Serve the mark certificate your CA issued, in PEM form, at the URL the `a=` tag of `default._bimi.{domain}` names.",
    },
    "mail/dane": {
        fact: "site.hosts.*.mail.dane",
        when: present("dane", "array"),
        expect: { items: { properties: { tlsa: { minimum: 1 }, signed: { const: true } } } },
        message: "an exchange has no DNSSEC-signed TLSA record at _25._tcp, so senders cannot authenticate its certificate (got {got})",
        severity: "hint",
        docs: "https://www.rfc-editor.org/rfc/rfc7672",
        fix: "Sign the zone of each Mail server of `{host}` and add a TLSA record at Name `_25._tcp.<mail server>` with Usage `3`, Selector `1`, Matching type `1` and the hash of its key.",
    },
    "mail/starttls": {
        fact: "site.hosts.*.mail.starttls",
        when: present("starttls", "array"),
        expect: { items: { properties: { offered: { const: true } } } },
        message: "an exchange does not offer STARTTLS on port 25, so mail to it travels in the clear (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc3207",
        fix: "Turn on STARTTLS with a certificate for the Mail server name on every MX of `{host}`.",
    },
    "mail/starttls-certificate": {
        fact: "site.hosts.*.mail.starttls",
        when: present("starttls", "array"),
        expect: { items: { anyOf: [{ properties: { offered: { const: false } } }, { properties: { authorized: { const: true } } }] } },
        message: "an exchange’s STARTTLS certificate does not validate for its name, so MTA-STS and DANE senders refuse it (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc8461#section-4.2",
        fix: "Install a certificate from a public CA covering the Mail server name, with its full chain, on every MX of `{host}`.",
    },
    "mail/starttls-banner": {
        fact: "site.hosts.*.mail.starttls",
        when: present("starttls", "array"),
        expect: { items: { properties: { "banner-matches": { const: true } } } },
        message: "an exchange’s 220 banner names a host its address’s PTR does not, which some receivers score as spam (got {got})",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc5321#section-4.3.1",
        fix: "Make the SMTP greeting name of each MX of `{host}` and the PTR record of its address the same name.",
    },
};

// The dns:mail rules a mail name answers to, kept under their IDs.
const CARRIED = ["dns/null-mx-mixed", "dns/spf-record", "dns/spf-all", "dns/dmarc-policy"];
const RECOMMENDED = [...CARRIED, "mail/spf-syntax", "mail/spf-lookups", "mail/spf-void-lookups", "mail/spf-include", "mail/dmarc-record", "mail/dmarc-syntax", "mail/dmarc-report-uri", "mail/dmarc-external", "mail/mx-resolves", "mail/mx-cname", "mail/mx-literal", "mail/mx-duplicate"];
const ALL: Record<string, RuleSpec> = { ...Object.fromEntries(CARRIED.map((id) => [id, MAIL_RULES[id] as RuleSpec])), ...RULES };

// Mail authentication of every crawled host and its registrable domain: SPF, DMARC, DKIM, MX, MTA-STS, TLS-RPT, BIMI, and opt-in DANE and STARTTLS.
export default definePlugin({
    name: "mail",
    settings: { type: "object", additionalProperties: false, properties: { mode: { enum: ["auto", "mail", "none"], default: "auto" }, "dkim-selectors": { type: "array", items: { type: "string", pattern: "^[A-Za-z0-9._-]+$" }, default: [] }, dane: { type: "boolean", default: false }, starttls: { type: "boolean", default: false } } },
    sites: [mail],
    presets: {
        mail: { description: "Mail authentication of names that take or send mail: SPF grammar and lookups, DMARC, DKIM keys, MX, MTA-STS, TLS-RPT and BIMI; DANE and STARTTLS once turned on", rules: ALL },
        "mail:recommended": { description: "SPF, DMARC and MX correctness of names that take or send mail", rules: Object.fromEntries(RECOMMENDED.map((id) => [id, { ...(ALL[id] as RuleSpec), severity: "warning" }])) },
    },
});
