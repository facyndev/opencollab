import type { ReactNode } from "react";

export function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="shell">
      <div className="card">
        <p className="brand">OpenCollab</p>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}
