import { useState } from "react";
import { api, invalidateAll } from "../lib/api";
import { Button, ErrorBox, Input, Label, Mark } from "./ui";

export default function Login() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid h-full place-items-center p-4">
      <form className="w-full max-w-[320px]"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/login", { body: { password: pw } });
            await invalidateAll();
          } catch (e) {
            setErr(e);
          } finally {
            setBusy(false);
          }
        }}>
        <Mark size={28} />
        <h1 className="mt-4 mb-1 text-lg">Sign in to Open CRM</h1>
        <Label>Password</Label>
        <Input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
        <ErrorBox error={err} />
        <Button type="submit" variant="primary" className="mt-4 h-[34px] w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
    </div>
  );
}
