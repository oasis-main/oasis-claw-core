// The name that autoreviewer text uses for the human who runs this instance.
// Set OASIS_OPERATOR_NAME in autoreviewer/.env. Without it the text says
// "the operator". A name is a label and gives no authority.

const GENERIC = "the operator";
const SAFE_NAME = /^\p{L}[\p{L}\p{M} .'’-]{0,39}$/u;

export function cleanOperatorName(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return SAFE_NAME.test(text) && !/^(the )?operator$/i.test(text) ? text : "";
}

export function operatorName() {
  return cleanOperatorName(process.env.OASIS_OPERATOR_NAME) || GENERIC;
}

/** The name at the start of a sentence. */
export function operatorNameStart() {
  const name = operatorName();
  return name === GENERIC ? "The operator" : name;
}

/** The name in a heading in capital letters. */
export function operatorNameCaps() {
  return operatorName().toUpperCase();
}
