/** CSS Modules type declaration (classes map; styles injected by the bundle). */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
