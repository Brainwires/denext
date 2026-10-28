import { auth, type AuthSession, hashPassword } from "denext/server";
import { smtpMailer } from "@denext/auth";

export const mailer = smtpMailer({ host: "smtp.example.com", from: "a@example.com" });
export const hash = (password: string) => hashPassword(password);
export const current = (): Promise<AuthSession | null> => auth();
