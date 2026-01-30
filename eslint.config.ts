/**
* SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
* SPDX-License-Identifier: MIT
*/

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["node_modules", "dist", "coverage"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      quotes: ["error", "double", { avoidEscape: true }],
      semi: ["error", "always"],
    },
  },
);
