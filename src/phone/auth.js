import { timingSafeEqual } from "node:crypto";

export function authorizeOperator(authorization, operatorToken) {
  if (!operatorToken) return "unconfigured";
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return "unauthorized";
  }

  const suppliedToken = Buffer.from(authorization.slice("Bearer ".length));
  const expectedToken = Buffer.from(operatorToken);

  return suppliedToken.length === expectedToken.length && timingSafeEqual(suppliedToken, expectedToken)
    ? "authorized"
    : "unauthorized";
}

export function requireOperator(config) {
  return (request, response, next) => {
    const result = authorizeOperator(request.headers.authorization, config.operatorToken);

    if (result === "unconfigured") {
      return response.status(503).json({ error: { code: "operator_not_configured" } });
    }

    if (result !== "authorized") {
      response.set("WWW-Authenticate", 'Bearer realm="errand-operator"');
      return response.status(401).json({ error: { code: "unauthorized" } });
    }

    next();
  };
}
