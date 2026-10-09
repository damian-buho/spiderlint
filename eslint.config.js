// Copyright 2026 Damián Búho
// SPDX-License-Identifier: AGPL-3.0-only

import js from "@eslint/js";
import nPlugin from "eslint-plugin-n";
import { flatConfigs } from "eslint-plugin-import-x";
import promisePlugin from "eslint-plugin-promise";
import unicornPlugin from "eslint-plugin-unicorn";
import prettierConfig from "eslint-config-prettier";
import tsdocPlugin from "eslint-plugin-tsdoc";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["coverage/", "node_modules/", "tmp/", "out/", "dist/", "**/*.tmp.*"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    nPlugin.configs["flat/recommended-module"],
    flatConfigs.recommended,
    promisePlugin.configs["flat/recommended"],
    unicornPlugin.configs["flat/recommended"],
    prettierConfig,
    {
        files: ["**/*.js", "**/*.ts"],
        ignores: ["eslint.config.js"],
        plugins: {
            tsdoc: tsdocPlugin,
        },
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: "module",
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "tsdoc/syntax": "warn",
            "n/no-unpublished-import": "off",
            "n/no-unsupported-features/node-builtins": [
                "error",
                {
                    allowExperimental: true,
                },
            ],
            "import-x/no-unresolved": "off",
            "n/hashbang": "off",
            "unicorn/throw-new-error": "off",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                },
            ],
        },
    },
);
