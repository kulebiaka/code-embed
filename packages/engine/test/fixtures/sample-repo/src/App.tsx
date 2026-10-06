import { useState } from "react";
import { formatCurrency, type Payment } from "./payment/refund";

interface RefundButtonProps {
  payment: Payment;
  onRefund: (paymentId: string) => Promise<void>;
}

export function RefundButton({ payment, onRefund }: RefundButtonProps) {
  const [busy, setBusy] = useState(false);
  const remaining = payment.amountCents - payment.refundedCents;

  async function handleClick() {
    setBusy(true);
    try {
      await onRefund(payment.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button disabled={busy || remaining <= 0} onClick={handleClick}>
      Refund {formatCurrency(remaining, payment.currency)}
    </button>
  );
}

export default function App({ payments }: { payments: Payment[] }) {
  return (
    <main>
      <h1>Payments</h1>
      <ul>
        {payments.map((p) => (
          <li key={p.id}>
            Order {p.orderId}: <RefundButton payment={p} onRefund={async () => {}} />
          </li>
        ))}
      </ul>
    </main>
  );
}
