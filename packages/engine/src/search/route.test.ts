import { describe, expect, it } from "vitest";
import { routeWeights } from "./route";

describe("routeWeights", () => {
  it.each([
    ["processPaymentRefund", 0.7, 0.3],
    ["PaymentService.refund", 0.7, 0.3],
    ["std::vector", 0.7, 0.3],
    ["$scope", 0.7, 0.3],
    ["возврат платежа", 0.1, 0.9],
    ["как работает возврат", 0.1, 0.9],
    ["parse config file", 0.3, 0.7],
    ["how to refund", 0.3, 0.7],
    ["a-b", 0.3, 0.7],
  ])("%s", (q, lexical, semantic) => {
    expect(routeWeights(q)).toEqual({ lexical, semantic });
  });
});
