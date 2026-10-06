export const PAYMENT_API_SECRET = "this-file-must-never-be-indexed";

export function refundWithSecret(paymentId: string): string {
  return `${paymentId}:${PAYMENT_API_SECRET}`;
}
