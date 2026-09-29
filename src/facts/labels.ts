// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

// Formats a number the way the caller’s locale writes it.
export type NumberFormat = (value: number, options?: Intl.NumberFormatOptions) => string;

// A fact’s unit as `Intl` names it; a count has none.
type Unit = "byte" | "millisecond" | "gram";

const BYTE_UNITS: [number, string][] = [
    [1e9, "gigabyte"],
    [1e6, "megabyte"],
    [1e3, "kilobyte"],
    [1, "byte"],
];

// Labels and units of the fact paths people read most; every other path is shown as itself.
const LABELS: Record<string, [label: string, unit?: Unit]> = {
    "co2.bytes": ["Transfer size", "byte"],
    "co2.resources": ["Resources weighed"],
    "co2.grams": ["CO₂e per view", "gram"],
    "co2.rating": ["CO₂ rating"],
    "http.size.body": ["Page size", "byte"],
    "http.size.decoded": ["Decoded size", "byte"],
    "http.size.declared": ["Declared size", "byte"],
    "browser.weight.script": ["Script transfer", "byte"],
    "browser.weight.style": ["Style transfer", "byte"],
    "browser.weight.image": ["Image transfer", "byte"],
    "browser.weight.font": ["Font transfer", "byte"],
    "resources.length": ["Resources"],
    "http.timing.wait": ["Socket wait", "millisecond"],
    "http.timing.dns": ["DNS lookup", "millisecond"],
    "http.timing.tcp": ["TCP connect", "millisecond"],
    "http.timing.tls": ["TLS handshake", "millisecond"],
    "http.timing.request": ["Request upload", "millisecond"],
    "http.timing.ttfb": ["Time to first byte", "millisecond"],
    "http.timing.download": ["Download", "millisecond"],
    "http.timing.total": ["Total time", "millisecond"],
    "browser.timing.dom-content-loaded": ["DOM ready", "millisecond"],
    "browser.timing.load": ["Page load", "millisecond"],
    "lighthouse.vitals.lcp": ["Largest Contentful Paint", "millisecond"],
    "lighthouse.vitals.fcp": ["First Contentful Paint", "millisecond"],
    "lighthouse.vitals.tbt": ["Total Blocking Time", "millisecond"],
    "lighthouse.vitals.si": ["Speed Index", "millisecond"],
    "lighthouse.vitals.ttfb": ["Server response time", "millisecond"],
    "lighthouse.vitals.cls": ["Cumulative Layout Shift"],
    "http.status": ["Status"],
    "http.version": ["HTTP version"],
    group: ["Group"],
};

// A path’s English label, undefined when it has none.
export function label(path: string): string | undefined {
    return LABELS[path]?.[0];
}

// Bytes in the largest unit they reach.
export function bytes(value: number, format: NumberFormat): string {
    const [scale, unit] = BYTE_UNITS.find(([floor]) => value >= floor) ?? [1, "byte"];
    return format(value / scale, { style: "unit", unit });
}

// A value with its path’s unit: four decimals below 1, one above, never a signed zero; bytes scaled.
export function withUnit(path: string, value: number, format: NumberFormat): string {
    const unit = LABELS[path]?.[1];
    if (unit === "byte") return bytes(value, format);
    const digits: Intl.NumberFormatOptions = { maximumFractionDigits: Math.abs(value) < 1 ? 4 : 1, signDisplay: "negative" };
    return format(value, unit ? { ...digits, style: "unit", unit } : digits);
}
