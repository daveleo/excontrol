/**
 * One place for the product identity. The display name can be overridden per install
 * via `app.name` in the config; everything else is fixed at build time.
 */
export const BRAND = {
  /** default display name — `app.name` in the config overrides this at runtime */
  name: "eXcontrol",
  /** lowercase id used for package names, the config filename, log prefixes */
  slug: "excontrol",
  /** folder under %ProgramData% / ~/.config for runtime config + logs */
  dataDirName: "eXcontrol",
  /** GitHub repo the updater checks for new releases */
  repo: "daveleo/excontrol",
  tagline: "Control overlay for LED installations",
} as const;
