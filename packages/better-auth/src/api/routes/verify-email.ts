import { TimeSpan } from "oslo";
import { createJWT, validateJWT, type JWT } from "oslo/jwt";
import { z } from "zod";
import { createAuthEndpoint } from "../call";

export async function createEmailVerificationToken(
	secret: string,
	email: string,
) {
	const token = await createJWT(
		"HS256",
		Buffer.from(secret),
		{
			email: email.toLowerCase(),
		},
		{
			expiresIn: new TimeSpan(1, "h"),
			issuer: "better-auth",
			subject: "verify-email",
			audiences: [email],
			includeIssuedTimestamp: true,
		},
	);
	return token;
}

export const sendVerificationEmail = createAuthEndpoint(
	"/send-verification-email",
	{
		method: "POST",
		body: z.object({
			email: z.string().email(),
			callbackURL: z.string().optional(),
		}),
	},
	async (ctx) => {
		if (!ctx.context.options.emailAndPassword?.sendVerificationEmail) {
			return ctx.json(null, {
				status: 400,
				statusText: "VERIFICATION_EMAIL_NOT_SENT",
				body: {
					message: "Verification email isn't enabled",
				},
			});
		}
		const { email } = ctx.body;
		const token = await createEmailVerificationToken(ctx.context.secret, email);
		const url = `${ctx.context.baseURL}/verify-email?token=${token}?callbackURL=${ctx.body.callbackURL}`;
		await ctx.context.options.emailAndPassword.sendVerificationEmail(
			email,
			url,
			token,
		);
		return ctx.json({
			status: true,
		});
	},
);

export const verifyEmail = createAuthEndpoint(
	"/verify-email",
	{
		method: "GET",
		query: z.object({
			token: z.string(),
			callbackURL: z.string().optional(),
		}),
	},
	async (ctx) => {
		const { token } = ctx.query;
		let jwt: JWT;
		try {
			jwt = await validateJWT("HS256", Buffer.from(ctx.context.secret), token);
		} catch (e) {
			ctx.context.logger.error("Failed to verify email", e);
			return ctx.json(null, {
				status: 400,
				statusText: "INVALID_TOKEN",
				body: {
					message: "Invalid token",
				},
			});
		}

		const schema = z.object({
			email: z.string().email(),
		});
		const parsed = schema.parse(jwt.payload);
		const user = await ctx.context.internalAdapter.findUserByEmail(
			parsed.email,
		);
		if (!user) {
			return ctx.json(null, {
				status: 400,
				statusText: "USER_NOT_FOUND",
				body: {
					message: "User not found",
				},
			});
		}
		const account = user.accounts.find((a) => a.providerId === "credential");
		if (!account) {
			return ctx.json(null, {
				status: 400,
				statusText: "ACCOUNT_NOT_FOUND",
				body: {
					message: "Account not found",
				},
			});
		}
		await ctx.context.internalAdapter.updateUserByEmail(parsed.email, {
			emailVerified: true,
		});
		if (ctx.query.callbackURL) {
			throw ctx.redirect(ctx.query.callbackURL);
		}
		return ctx.json({
			status: true,
		});
	},
);