// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

// First-party cookie names analytics and advertising scripts set, by vendor, hand-kept as of 2026-09-26; `*` matches any suffix.
export const TRACKING_COOKIES: Record<string, string[]> = {
    "Adobe Analytics": ["s_cc", "s_sq", "s_vi", "s_fid", "AMCV_*", "AMCVS_*"],
    Amplitude: ["amp_*", "amplitude_id*"],
    "Bing Ads": ["_uetsid", "_uetvid"],
    "Google Ads": ["_gcl_au", "_gcl_aw", "_gcl_dc", "_gcl_gb"],
    "Google Analytics": ["_ga", "_ga_*", "_gid", "_gat", "_gat_*", "__utma", "__utmb", "__utmc", "__utmt", "__utmz"],
    Heap: ["_hp2_*"],
    Hotjar: ["_hjSessionUser_*", "_hjSession_*", "_hjid", "_hjFirstSeen", "_hjAbsoluteSessionInProgress"],
    HubSpot: ["hubspotutk", "__hstc", "__hssc", "__hssrc"],
    "LinkedIn Insight": ["li_fat_id", "_li_dcdm_c"],
    Matomo: ["_pk_id.*", "_pk_ses.*", "_pk_ref.*"],
    "Meta Pixel": ["_fbp", "_fbc"],
    "Microsoft Clarity": ["_clck", "_clsk"],
    Mixpanel: ["mp_*"],
    Pinterest: ["_pin_unauth", "_pinterest_ct_ua"],
    Reddit: ["_rdt_uuid"],
    Segment: ["ajs_anonymous_id", "ajs_user_id"],
    Snapchat: ["_scid", "_sctr"],
    "TikTok Pixel": ["_ttp", "_tt_enable_cookie"],
    "Yandex Metrica": ["_ym_uid", "_ym_d", "_ym_isad", "_ym_visorc"],
};
