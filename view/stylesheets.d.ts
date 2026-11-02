/** A stylesheet imported with { type: "text" }: its text, which the view puts in a style element. */
declare module "*.css" {
  const text: string;
  export default text;
}
