// pages/payment-success.tsx

export default function PaymentSuccess() {
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
          ✅ Payment Successful
        </h1>

        <p style={{ fontSize: 15, color: "#374151", marginBottom: 16 }}>
          Thank you. Your payment has been confirmed.
        </p>

        <p style={{ fontSize: 14, color: "#6b7280" }}>
          A contractor will be assigned shortly.<br />
          You will receive updates via WhatsApp.
        </p>
      </div>
    </div>
  );
}
