export default function PaymentCancelled() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, sans-serif",
        background: "#f9fafb",
      }}
    >
      <div
        style={{
          maxWidth: 420,
          padding: 24,
          background: "#ffffff",
          borderRadius: 12,
          boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: 22, marginBottom: 12 }}>
          ❌ Payment Cancelled
        </h1>

        <p style={{ fontSize: 15, color: "#374151", marginBottom: 16 }}>
          Your payment was not completed.
        </p>

        <p style={{ fontSize: 14, color: "#6b7280" }}>
          You may return to WhatsApp and reply <strong>PAY</strong> to try again.
          <br />
          No charges have been made.
        </p>
      </div>
    </div>
  );
}
