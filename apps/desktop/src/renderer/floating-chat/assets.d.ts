// owner: floating-chat. Vite's text imports: the wizard SVG inline and the shadow stylesheet as a string.
declare module "*.svg?raw" {
  const text: string;
  export default text;
}
declare module "*.css?inline" {
  const text: string;
  export default text;
}
