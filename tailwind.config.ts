import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0b0d10",
          elevated: "#13171c",
          panel: "#171c22",
          border: "#232a32",
        },
        accent: {
          DEFAULT: "#7c5cff",
          muted: "#5f48cc",
        },
        ink: {
          DEFAULT: "#e6edf3",
          muted: "#9aa6b2",
          dim: "#6b7785",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
