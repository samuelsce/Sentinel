"use client";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { request, type Session } from "../lib/models";
import { Button } from "./ui/button";

export function Login() {
  const router = useRouter(),
    cache = useQueryClient();
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  return (
    <div className="login-page">
      <div className="login-story">
        <Link className="brand" href="/">
          <ShieldCheck aria-hidden="true" />
          Sentinel
        </Link>
        <div>
          <h2>Do sinal à evidência.</h2>
          <p>
            Entenda o que aconteceu na sua aplicação e acompanhe cada
            investigação.
          </p>
          <div className="login-path">
            <span>Eventos</span>
            <span>Detecções</span>
            <span>Evidências</span>
          </div>
        </div>
        <p>Fullstack, AppSec e Blue Team.</p>
      </div>
      <main className="login-form">
        <Link className="back-link" href="/">
          <ArrowLeft aria-hidden="true" />
          Voltar ao projeto
        </Link>
        <h1>Acesse seu workspace</h1>
        <p className="muted">
          Entre com a conta provisionada para sua organização.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            setPending(true);
            const form = e.currentTarget,
              data = new FormData(form);
            try {
              const session = await request<Session>("/v1/auth/login", {
                method: "POST",
                body: JSON.stringify({
                  email: data.get("email"),
                  password: data.get("password"),
                }),
              });
              form.reset();
              cache.clear();
              cache.setQueryData(["session"], session);
              router.replace("/dashboard");
            } catch (err) {
              setError(err instanceof Error ? err.message : "Tente novamente.");
            } finally {
              setPending(false);
            }
          }}
        >
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="username"
              required
              maxLength={254}
            />
          </label>
          <label>
            Senha
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </label>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Entrando…" : "Entrar no Sentinel"}
          </Button>
        </form>
        <div className="login-note">
          <strong>Primeiro acesso?</strong>
          <p>
            O administrador provisiona sua conta pelo comando local descrito no
            README. Não há cadastro público nem senha padrão.
          </p>
        </div>
      </main>
    </div>
  );
}
