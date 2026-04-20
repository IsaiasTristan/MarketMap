import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Allow unused vars in new analysis module during rapid development
      "@typescript-eslint/no-unused-vars": "warn",
      // Allow any types in service layer for Prisma callback parameters
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow unused parameters prefixed with _
      "no-unused-vars": "off",
    },
    files: ["src/components/analysis/**/*.{ts,tsx}", "src/server/services/**/*.ts", "src/app/api/analysis/**/*.ts"],
  },
];

export default eslintConfig;
