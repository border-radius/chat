import PocketBase, { type RecordModel } from "pocketbase";
import { inject } from "vitest";
import { SUPERUSER } from "./setup/pocketbase.ts";

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Fresh SDK client with an in-memory auth store, so clients never share tokens. */
export function client(): PocketBase {
  const pb = new PocketBase(inject("pbUrl"));
  pb.autoCancellation(false);
  return pb;
}

export async function adminClient(): Promise<PocketBase> {
  const pb = client();
  await pb.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
  return pb;
}

export interface TestUser {
  pb: PocketBase;
  user: RecordModel;
  email: string;
  password: string;
}

export async function newUser(name = `user-${uniq()}`): Promise<TestUser> {
  const pb = client();
  const email = `${name}@test.local`;
  const password = "password-123";
  await pb.collection("users").create({ email, password, passwordConfirm: password, name });
  const { record } = await pb.collection("users").authWithPassword(email, password);
  return { pb, user: record, email, password };
}

export async function newRoom(u: TestUser, name = `room-${uniq()}`): Promise<RecordModel> {
  return u.pb.collection("rooms").create({ name, created_by: u.user.id });
}

export async function post(u: TestUser, room: string, text: string, extra: Record<string, unknown> = {}) {
  return u.pb.collection("messages").create({ room, author: u.user.id, text, ...extra });
}
