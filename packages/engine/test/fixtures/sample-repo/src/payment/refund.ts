export type Currency = "USD" | "EUR" | "RUB";

export interface Payment {
  id: string;
  orderId: string;
  amountCents: number;
  currency: Currency;
  capturedAt: Date;
  refundedCents: number;
}

export interface RefundRequest {
  paymentId: string;
  amountCents?: number;
  reason: string;
}

export interface RefundResult {
  paymentId: string;
  refundedCents: number;
  status: "refunded" | "partially_refunded" | "rejected";
  message?: string;
}

const REFUND_WINDOW_DAYS = 90;

export function calculateRefundAmount(payment: Payment, requested?: number): number {
  const remaining = payment.amountCents - payment.refundedCents;
  if (requested === undefined) return remaining;
  return Math.max(0, Math.min(requested, remaining));
}

export function validateRefundRequest(payment: Payment, request: RefundRequest, now: Date = new Date()): string | null {
  if (request.amountCents !== undefined && request.amountCents <= 0) {
    return "refund amount must be positive";
  }
  const ageDays = (now.getTime() - payment.capturedAt.getTime()) / 86_400_000;
  if (ageDays > REFUND_WINDOW_DAYS) {
    return `refund window of ${REFUND_WINDOW_DAYS} days has expired`;
  }
  if (payment.refundedCents >= payment.amountCents) {
    return "payment is already fully refunded";
  }
  return null;
}

export function formatCurrency(cents: number, currency: Currency): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export interface PaymentGateway {
  refund(paymentId: string, amountCents: number): Promise<void>;
}

export class PaymentService {
  private readonly payments = new Map<string, Payment>();

  constructor(private readonly gateway: PaymentGateway) {}

  register(payment: Payment): void {
    this.payments.set(payment.id, payment);
  }

  async processPaymentRefund(request: RefundRequest): Promise<RefundResult> {
    const payment = this.payments.get(request.paymentId);
    if (!payment) {
      return { paymentId: request.paymentId, refundedCents: 0, status: "rejected", message: "payment not found" };
    }
    const error = validateRefundRequest(payment, request);
    if (error) {
      return { paymentId: payment.id, refundedCents: 0, status: "rejected", message: error };
    }
    const amount = calculateRefundAmount(payment, request.amountCents);
    await this.gateway.refund(payment.id, amount);
    payment.refundedCents += amount;
    const status = payment.refundedCents >= payment.amountCents ? "refunded" : "partially_refunded";
    return { paymentId: payment.id, refundedCents: amount, status };
  }
}
