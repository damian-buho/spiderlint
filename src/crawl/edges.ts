// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

// Display names of the edges `edgeOf`, `wallOf` and `servedBy` return.
const EDGE_NAMES: Record<string, string> = { cloudflare: "Cloudflare", datadome: "DataDome", imperva: "Imperva", "aws-waf": "AWS WAF", akamai: "Akamai", fastly: "Fastly", cloudfront: "Amazon CloudFront" };

// An edge’s display name, its ID when it has none.
export function edgeName(edge: string): string {
    return EDGE_NAMES[edge] ?? edge;
}

// The CDN that served an answer of any status, by the headers it stamps on its own pages; undefined when none is seen.
export function servedBy(headers: Record<string, string | string[]>): string | undefined {
    const header = (name: string) => [headers[name] ?? []].flat().join(",").toLowerCase();
    if (header("server") === "cloudflare" || header("cf-ray")) return "cloudflare";
    if (header("server").startsWith("akamaighost") || Object.keys(headers).some((name) => name.startsWith("akamai-"))) return "akamai";
    if (header("x-amz-cf-id") || header("via").includes("cloudfront")) return "cloudfront";
    if (/(^|,)\s*cache-[a-z0-9-]+/.test(header("x-served-by")) || header("x-fastly-request-id")) return "fastly";
    return undefined;
}
