import { getNewUserInvitations } from "@/features/auth/helpers/getNewUserInvitations";
import { sendVerificationRequest } from "@/features/auth/helpers/sendVerificationRequest";
import * as Sentry from "@sentry/nextjs";
import { env } from "@typebot.io/env";
import { getIp } from "@typebot.io/lib/getIp";
import { mockedUser } from "@typebot.io/lib/mockedUser";
import { getAtPath, isDefined } from "@typebot.io/lib/utils";
import prisma from "@typebot.io/prisma";
import type { Prisma } from "@typebot.io/prisma/types";
import { trackEvents } from "@typebot.io/telemetry/trackEvents";
import { Ratelimit } from "@upstash/ratelimit";
import Redis from "ioredis";
import ky from "ky";
import type { NextApiRequest, NextApiResponse } from "next";
import NextAuth, { type Account, type AuthOptions } from "next-auth";
import type { AdapterUser } from "next-auth/adapters";
import AzureADProvider from "next-auth/providers/azure-ad";
import CredentialsProvider from "next-auth/providers/credentials";
import EmailProvider from "next-auth/providers/email";
import FacebookProvider from "next-auth/providers/facebook";
import GitHubProvider from "next-auth/providers/github";
import GitlabProvider from "next-auth/providers/gitlab";
import GoogleProvider from "next-auth/providers/google";
import type { Provider } from "next-auth/providers/index";
import KeycloakProvider from "next-auth/providers/keycloak";
import { customAdapter } from "../../../features/auth/api/customAdapter";

const customDataAdapter = customAdapter(prisma);

const providers: Provider[] = [];

let emailSignInRateLimiter: Ratelimit | undefined;

providers.push(
  CredentialsProvider({
    name: "credentials",
    credentials: {
      authToken: { label: "AuthToken", type: "text" },
      apiHost: { label: "APIHost", type: "text" },
      tenantId: { label: "TenantId", type: "text" },
    },
    async authorize(credentials) {
      if (credentials?.authToken !== env.TYPEBOT_CODE) {
        return null;
      }

      const host = credentials?.apiHost;
      try {
        const response = await ky.get(`${host}/api/typebot/client`, {
          headers: {
            tenantId: credentials?.tenantId,
          },
        });
        const user = (await response.json()) as Prisma.User;

        const find = await customDataAdapter.getUser(user.id);

        if (!find) {
          const userAdater = await customDataAdapter.createUser({
            ...(user as AdapterUser),
          });

          user.id = userAdater.id;
          user.name = userAdater.name || null;
          user.email = userAdater.email;
          user.image = userAdater.image || null;
        }

        return user;
      } catch (error) {
        console.error("Erro ao fazer a requisição:", error);
        return null;
      }
    },
  }),
);

if (env.REDIS_URL) {
  const redis = new Redis(env.REDIS_URL);
  const rateLimitCompatibleRedis = {
    sadd: <TData>(key: string, ...members: TData[]) =>
      redis.sadd(key, ...members.map((m) => String(m))),
    eval: async <TArgs extends unknown[], TData = unknown>(
      script: string,
      keys: string[],
      args: TArgs,
    ) =>
      redis.eval(
        script,
        keys.length,
        ...keys,
        ...(args ?? []).map((a) => String(a)),
      ) as Promise<TData>,
  };
  emailSignInRateLimiter = new Ratelimit({
    redis: rateLimitCompatibleRedis,
    limiter: Ratelimit.slidingWindow(1, "60 s"),
  });
}

if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
  providers.push(
    GitHubProvider({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    }),
  );

if (env.NEXT_PUBLIC_SMTP_FROM && !env.SMTP_AUTH_DISABLED)
  providers.push(
    EmailProvider({
      server: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        ignoreTLS: env.SMTP_IGNORE_TLS,
        auth:
          env.SMTP_USERNAME || env.SMTP_PASSWORD
            ? {
                user: env.SMTP_USERNAME,
                pass: env.SMTP_PASSWORD,
              }
            : undefined,
      },
      maxAge: 5 * 60,
      from: env.NEXT_PUBLIC_SMTP_FROM,
      generateVerificationToken() {
        const code = Math.floor(100000 + Math.random() * 900000); // random 6-digit code
        return code.toString();
      },
      sendVerificationRequest,
    }),
  );

if (env.GOOGLE_AUTH_CLIENT_ID && env.GOOGLE_AUTH_CLIENT_SECRET)
  providers.push(
    GoogleProvider({
      clientId: env.GOOGLE_AUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_AUTH_CLIENT_SECRET,
    }),
  );

if (env.FACEBOOK_CLIENT_ID && env.FACEBOOK_CLIENT_SECRET)
  providers.push(
    FacebookProvider({
      clientId: env.FACEBOOK_CLIENT_ID,
      clientSecret: env.FACEBOOK_CLIENT_SECRET,
    }),
  );

if (env.GITLAB_CLIENT_ID && env.GITLAB_CLIENT_SECRET) {
  const BASE_URL = env.GITLAB_BASE_URL;
  providers.push(
    GitlabProvider({
      clientId: env.GITLAB_CLIENT_ID,
      clientSecret: env.GITLAB_CLIENT_SECRET,
      authorization: `${BASE_URL}/oauth/authorize?scope=read_api`,
      token: `${BASE_URL}/oauth/token`,
      userinfo: `${BASE_URL}/api/v4/user`,
      name: env.GITLAB_NAME,
    }),
  );
}

if (
  env.AZURE_AD_CLIENT_ID &&
  env.AZURE_AD_CLIENT_SECRET &&
  env.AZURE_AD_TENANT_ID
) {
  providers.push(
    AzureADProvider({
      clientId: env.AZURE_AD_CLIENT_ID,
      clientSecret: env.AZURE_AD_CLIENT_SECRET,
      tenantId: env.AZURE_AD_TENANT_ID,
    }),
  );
}

if (
  env.KEYCLOAK_CLIENT_ID &&
  env.KEYCLOAK_BASE_URL &&
  env.KEYCLOAK_CLIENT_SECRET &&
  env.KEYCLOAK_REALM
) {
  providers.push(
    KeycloakProvider({
      clientId: env.KEYCLOAK_CLIENT_ID,
      clientSecret: env.KEYCLOAK_CLIENT_SECRET,
      issuer: `${env.KEYCLOAK_BASE_URL}/${env.KEYCLOAK_REALM}`,
    }),
  );
}

if (env.CUSTOM_OAUTH_WELL_KNOWN_URL) {
  providers.push({
    id: "custom-oauth",
    name: env.CUSTOM_OAUTH_NAME,
    type: "oauth",
    authorization: {
      params: {
        scope: env.CUSTOM_OAUTH_SCOPE,
      },
    },
    clientId: env.CUSTOM_OAUTH_CLIENT_ID,
    clientSecret: env.CUSTOM_OAUTH_CLIENT_SECRET,
    wellKnown: env.CUSTOM_OAUTH_WELL_KNOWN_URL,
    profile(profile) {
      return {
        id: getAtPath(profile, env.CUSTOM_OAUTH_USER_ID_PATH),
        name: getAtPath(profile, env.CUSTOM_OAUTH_USER_NAME_PATH),
        email: getAtPath(profile, env.CUSTOM_OAUTH_USER_EMAIL_PATH),
        image: getAtPath(profile, env.CUSTOM_OAUTH_USER_IMAGE_PATH),
      } as Prisma.User;
    },
  });
}

export const getAuthOptions = ({
  restricted,
}: {
  restricted?: "rate-limited";
}): AuthOptions => ({
  adapter: customDataAdapter,
  secret: env.ENCRYPTION_SECRET,
  providers,
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/signin",
    newUser: env.NEXT_PUBLIC_ONBOARDING_TYPEBOT_ID ? "/onboarding" : undefined,
    error: "/signin",
  },
  events: {
    signIn({ user }) {
      Sentry.setUser({ id: user.id });
    },
    async signOut({ session }) {
      Sentry.setUser(null);
      await trackEvents([
        {
          name: "User logged out",
          userId: (session as unknown as { userId: string }).userId,
        },
      ]);
    },
  },
  callbacks: {
    async jwt({ token, user, account, profile, isNewUser }) {
      if (account) {
        token.accessToken = account.access_token;
      }
      return token;
    },
    async redirect({ url, baseUrl }) {
      return baseUrl;
    },
    session: async ({ session, user, token }) => {
      (session.user as any).id = token.sub;
      const userFromDb = session?.user as Prisma.User;
      // await updateLastActivityDate(userFromDb);
      return {
        ...session,
        user: userFromDb,
      };
    },
    signIn: async ({ account, user }) => {
      if (restricted === "rate-limited") throw new Error("rate-limited");
      if (!account) return false;
      const isNewUser = !("createdAt" in user && isDefined(user.createdAt));
      if (
        isNewUser &&
        user.email &&
        (!env.ADMIN_EMAIL || !env.ADMIN_EMAIL.includes(user.email)) &&
        env.REJECT_DISPOSABLE_EMAILS
      ) {
        const data = await ky
          .get(
            "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf",
          )
          .text();
        const disposableEmailDomains = data.split("\n");
        if (disposableEmailDomains.includes(user.email.split("@")[1]))
          return false;
      }
      if (
        env.DISABLE_SIGNUP &&
        isNewUser &&
        user.email &&
        !env.ADMIN_EMAIL?.includes(user.email)
      ) {
        const { invitations, workspaceInvitations } =
          await getNewUserInvitations(prisma, user.email);
        if (invitations.length === 0 && workspaceInvitations.length === 0)
          throw new Error("sign-up-disabled");
      }
      const requiredGroups = getRequiredGroups(account.provider);
      if (requiredGroups.length > 0) {
        const userGroups = await getUserGroups(account);
        return checkHasGroups(userGroups, requiredGroups);
      }
      if (!isNewUser)
        await trackEvents([
          {
            name: "User logged in",
            userId: user.id,
          },
        ]);
      return true;
    },
  },
});

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  // Ignore email link openers (common in enterprise setups)
  if (req.method === "HEAD") return res.status(200).end();
  const isMockingSession =
    req.method === "GET" &&
    req.url === "/api/auth/session" &&
    env.NEXT_PUBLIC_E2E_TEST;
  if (isMockingSession) return res.send({ user: mockedUser });
  const requestIsFromCompanyFirewall = req.method === "HEAD";
  if (requestIsFromCompanyFirewall) return res.status(200).end();

  let restricted: "rate-limited" | undefined;

  if (
    emailSignInRateLimiter &&
    req.url?.startsWith("/api/auth/signin/email") &&
    req.method === "POST"
  ) {
    const ip = getIp(req);
    if (ip) {
      const { success } = await emailSignInRateLimiter.limit(ip);
      if (!success) restricted = "rate-limited";
    }
  }

  return await NextAuth(req, res, getAuthOptions({ restricted }));
};

const updateLastActivityDate = async (user: Prisma.User) => {
  const datesAreOnSameDay = (first: Date, second: Date) =>
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate();

  if (!datesAreOnSameDay(user.lastActivityAt, new Date())) {
    await prisma.user.updateMany({
      where: { id: user.id },
      data: { lastActivityAt: new Date() },
    });
    await trackEvents([
      {
        name: "User logged in",
        userId: user.id,
      },
    ]);
  }
};

const getUserGroups = async (account: Account): Promise<string[]> => {
  switch (account.provider) {
    case "gitlab": {
      const getGitlabGroups = async (
        accessToken: string,
        page = 1,
      ): Promise<{ full_path: string }[]> => {
        const res = await fetch(
          `${
            env.GITLAB_BASE_URL || "https://gitlab.com"
          }/api/v4/groups?per_page=100&page=${page}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        const groups: { full_path: string }[] = await res.json();
        const nextPage = Number.parseInt(res.headers.get("X-Next-Page") || "");
        if (nextPage)
          groups.push(...(await getGitlabGroups(accessToken, nextPage)));
        return groups;
      };
      const groups = await getGitlabGroups(account.access_token as string);
      return groups.map((group) => group.full_path);
    }
    default:
      return [];
  }
};

const getRequiredGroups = (provider: string): string[] => {
  switch (provider) {
    case "gitlab":
      return env.GITLAB_REQUIRED_GROUPS ?? [];
    default:
      return [];
  }
};

const checkHasGroups = (userGroups: string[], requiredGroups: string[]) =>
  userGroups?.some((userGroup) => requiredGroups?.includes(userGroup));

export default handler;
