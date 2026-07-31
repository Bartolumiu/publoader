import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Prisma JSON round-trips and zod passthroughs need occasional escapes;
      // keep them visible but non-fatal.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "docker/**"],
  },
);
