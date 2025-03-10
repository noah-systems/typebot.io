import { convertInvitationsToCollaborations } from "@/features/auth/helpers/convertInvitationsToCollaborations";
import { getNewUserInvitations } from "@/features/auth/helpers/getNewUserInvitations";
import { joinWorkspaces } from "@/features/auth/helpers/joinWorkspaces";
import { parseWorkspaceDefaultPlan } from "@/features/workspace/helpers/parseWorkspaceDefaultPlan";
import { createId } from "@paralleldrive/cuid2";
import { env } from "@typebot.io/env";
import { generateId } from "@typebot.io/lib/utils";
import { WorkspaceRole } from "@typebot.io/prisma/enum";
import type { Prisma } from "@typebot.io/prisma/types";
import type { TelemetryEvent } from "@typebot.io/telemetry/schemas";
import { trackEvents } from "@typebot.io/telemetry/trackEvents";
import ky from "ky";
import type { Account, Awaitable, User } from "next-auth";

// Forked from https://github.com/nextauthjs/adapters/blob/main/packages/prisma/src/index.ts

interface AdapterUser extends User {
  id: string;
  email: string;
  emailVerified: Date | null;
}

interface AdapterAccount extends Account {
  userId: string;
}
interface AdapterSession {
  sessionToken: string;
  userId: string;
  expires: Date;
}
interface VerificationToken {
  identifier: string;
  expires: Date;
  token: string;
}

type Adapter<WithVerificationToken = boolean> = DefaultAdapter &
  (WithVerificationToken extends true
    ? {
        createVerificationToken: (
          verificationToken: VerificationToken,
        ) => Awaitable<VerificationToken | null | undefined>;
        /**
         * Return verification token from the database
         * and delete it so it cannot be used again.
         */
        useVerificationToken: (params: {
          identifier: string;
          token: string;
        }) => Awaitable<VerificationToken | null>;
      }
    : {});
interface DefaultAdapter {
  createUser: (user: AdapterUser) => Awaitable<AdapterUser>;
  getUser: (id: string) => Awaitable<AdapterUser | null>;
  getUserByEmail: (email: string) => Awaitable<AdapterUser | null>;
  /** Using the provider id and the id of the user for a specific account, get the user. */
  getUserByAccount: (
    providerAccountId: Pick<AdapterAccount, "provider" | "providerAccountId">,
  ) => Awaitable<AdapterUser | null>;
  updateUser: (
    user: Partial<AdapterUser> & Pick<AdapterUser, "id">,
  ) => Awaitable<AdapterUser>;
  /** @todo Implement */
  deleteUser?: (
    userId: string,
  ) => Promise<void> | Awaitable<AdapterUser | null | undefined>;
  linkAccount: (
    account: AdapterAccount,
  ) => Promise<void> | Awaitable<AdapterAccount | null | undefined>;
  /** @todo Implement */
  unlinkAccount?: (
    providerAccountId: Pick<AdapterAccount, "provider" | "providerAccountId">,
  ) => Promise<void> | Awaitable<AdapterAccount | undefined>;
  /** Creates a session for the user and returns it. */
  createSession: (session: {
    sessionToken: string;
    userId: string;
    expires: Date;
  }) => Awaitable<AdapterSession>;
  getSessionAndUser: (sessionToken: string) => Awaitable<{
    session: AdapterSession;
    user: AdapterUser;
  } | null>;
  updateSession: (
    session: Partial<AdapterSession> & Pick<AdapterSession, "sessionToken">,
  ) => Awaitable<AdapterSession | null | undefined>;
  deleteSession: (
    sessionToken: string,
  ) => Promise<void> | Awaitable<AdapterSession | null | undefined>;
  createVerificationToken?: (
    verificationToken: VerificationToken,
  ) => Awaitable<VerificationToken | null | undefined>;
  useVerificationToken?: (params: {
    identifier: string;
    token: string;
  }) => Awaitable<VerificationToken | null>;
}

export function customAdapter(p: Prisma.PrismaClient): Adapter {
  return {
    createUser: async (data) => {
      if (!data.email) {
        throw Error("Provider did not forward email but it is required");
      }
      const user = { id: data?.id || createId(), email: data.email as string };
      const { invitations, workspaceInvitations } = await getNewUserInvitations(
        p,
        user.email,
      );
      if (
        env.DISABLE_SIGNUP &&
        env.ADMIN_EMAIL?.every((email) => email !== user.email) &&
        invitations.length === 0 &&
        workspaceInvitations.length === 0
      ) {
        throw Error("New users are forbidden");
      }
      const newWorkspaceData = {
        name: data.name ? `${data.name}'s workspace` : `My workspace`,
        plan: parseWorkspaceDefaultPlan(data.email),
      };
      const createdUser = await p.user.create({
        data: {
          ...data,
          id: user.id,
          apiTokens: {
            create: { name: "Default", token: generateId(24) },
          },
          workspaces:
            workspaceInvitations.length > 0
              ? undefined
              : {
                  create: {
                    role: WorkspaceRole.ADMIN,
                    workspace: {
                      create: newWorkspaceData,
                    },
                  },
                },
          onboardingCategories: [],
        },
        include: {
          workspaces: { select: { workspaceId: true } },
        },
      });
      const newWorkspaceId = createdUser.workspaces.pop()?.workspaceId;
      const events: TelemetryEvent[] = [];
      if (newWorkspaceId) {
        events.push({
          name: "Workspace created",
          workspaceId: newWorkspaceId,
          userId: createdUser.id,
        });
      }
      events.push({
        name: "User created",
        userId: createdUser.id,
      });
      if (env.USER_CREATED_WEBHOOK_URL) {
        try {
          await ky.post(env.USER_CREATED_WEBHOOK_URL, {
            json: {
              email: createdUser.email,
            },
          });
        } catch (e) {
          console.error("Failed to call user created webhook", e);
        }
      }
      await trackEvents(events);
      if (invitations.length > 0)
        await convertInvitationsToCollaborations(p, user, invitations);
      if (workspaceInvitations.length > 0)
        await joinWorkspaces(p, user, workspaceInvitations);
      return createdUser as AdapterUser;
    },
    getUser: async (id) =>
      (await p.user.findUnique({ where: { id } })) as AdapterUser,
    getUserByEmail: async (email) =>
      (await p.user.findUnique({ where: { email } })) as AdapterUser,
    async getUserByAccount(provider_providerAccountId) {
      const account = await p.account.findUnique({
        where: { provider_providerAccountId },
        select: { user: true },
      });
      return (account?.user ?? null) as AdapterUser | null;
    },
    updateUser: async (data) =>
      (await p.user.update({ where: { id: data.id }, data })) as AdapterUser,
    deleteUser: async (id) =>
      (await p.user.delete({ where: { id } })) as AdapterUser,
    linkAccount: async (data) => {
      await p.account.create({
        data: {
          userId: data.userId,
          type: data.type,
          provider: data.provider,
          providerAccountId: data.providerAccountId,
          refresh_token: data.refresh_token,
          access_token: data.access_token,
          expires_at: data.expires_at,
          token_type: data.token_type,
          scope: data.scope,
          id_token: data.id_token,
          session_state: data.session_state,
          oauth_token_secret: data.oauth_token_secret as string,
          oauth_token: data.oauth_token as string,
          refresh_token_expires_in: data.refresh_token_expires_in as number,
        },
      });
    },
    unlinkAccount: async (provider_providerAccountId) => {
      await p.account.delete({ where: { provider_providerAccountId } });
    },
    async getSessionAndUser(sessionToken) {
      const userAndSession = await p.session.findUnique({
        where: { sessionToken },
        include: { user: true },
      });
      if (!userAndSession) return null;
      const { user, ...session } = userAndSession;
      return { user, session } as {
        user: AdapterUser;
        session: AdapterSession;
      };
    },
    createSession: (data) => p.session.create({ data }),
    updateSession: (data) =>
      p.session.update({ data, where: { sessionToken: data.sessionToken } }),
    deleteSession: (sessionToken) =>
      p.session.delete({ where: { sessionToken } }),
    createVerificationToken: (data) => p.verificationToken.create({ data }),
    async useVerificationToken(identifier_token) {
      try {
        return await p.verificationToken.delete({
          where: { identifier_token },
        });
      } catch (error) {
        if (
          (error as Prisma.Prisma.PrismaClientKnownRequestError).code ===
          "P2025"
        )
          return null;
        throw error;
      }
    },
  };
}
