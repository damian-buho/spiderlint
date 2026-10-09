// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

// Analytics and ad-tech hosts by vendor, hand-kept as of 2026-09-25; a host matches itself and its subdomains.
export const TRACKERS: Record<string, string[]> = {
    "Adobe Analytics": ["omtrdc.net", "2o7.net", "demdex.net"],
    Amplitude: ["amplitude.com"],
    "Bing Ads": ["bat.bing.com"],
    Criteo: ["criteo.com", "criteo.net"],
    "Google Ads": ["doubleclick.net", "googleadservices.com", "googlesyndication.com", "adservice.google.com"],
    "Google Analytics": ["google-analytics.com", "analytics.google.com", "googletagmanager.com"],
    Heap: ["heapanalytics.com"],
    Hotjar: ["hotjar.com", "hotjar.io"],
    FullStory: ["fullstory.com"],
    "LinkedIn Insight": ["snap.licdn.com", "px.ads.linkedin.com"],
    "Meta Pixel": ["connect.facebook.net"],
    "Microsoft Clarity": ["clarity.ms"],
    Mixpanel: ["mixpanel.com", "mxpnl.com"],
    Outbrain: ["outbrain.com"],
    Quantcast: ["quantserve.com", "quantcount.com"],
    Scorecard: ["scorecardresearch.com"],
    Segment: ["segment.com", "segment.io"],
    Taboola: ["taboola.com"],
    "TikTok Pixel": ["analytics.tiktok.com"],
    "X Ads": ["static.ads-twitter.com", "ads-api.twitter.com"],
    "Yandex Metrica": ["mc.yandex.ru", "mc.yandex.com"],
};
