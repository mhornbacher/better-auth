import { z, ZodObject, ZodString } from "zod";
import { createAuthEndpoint } from "../call";
import { createEmailVerificationToken } from "./email-verification";
import { setSessionCookie } from "../../cookies";
import { APIError } from "better-call";
import type {
	AdditionalUserFieldsInput,
	BetterAuthOptions,
	InferSession,
	InferUser,
	User,
} from "../../types";
import type { toZod } from "../../types/to-zod";
import { parseUserInput } from "../../db/schema";

export const signUpEmail = <O extends BetterAuthOptions>() =>
	createAuthEndpoint(
		"/sign-up/email",
		{
			method: "POST",
			query: z
				.object({
					currentURL: z.string().optional(),
				})
				.optional(),
			body: z.record(z.string(), z.any()) as unknown as ZodObject<{
				name: ZodString;
				email: ZodString;
				password: ZodString;
			}> &
				toZod<AdditionalUserFieldsInput<O>>,
			metadata: {
				openapi: {
					description: "Sign up a user using email and password",
					requestBody: {
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										name: {
											type: "string",
											description: "The name of the user",
										},
										email: {
											type: "string",
											description: "The email of the user",
										},
										password: {
											type: "string",
											description: "The password of the user",
										},
										callbackURL: {
											type: "string",
											description:
												"The URL to use for email verification callback",
										},
									},
									required: ["name", "email", "password"],
								},
							},
						},
					},
					responses: {
						"200": {
							description: "Success",
							content: {
								"application/json": {
									schema: {
										type: "object",
										properties: {
											user: {
												type: "object",
											},
											session: {
												type: "object",
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
		async (ctx) => {
			if (!ctx.context.options.emailAndPassword?.enabled) {
				throw new APIError("BAD_REQUEST", {
					message: "Email and password sign up is not enabled",
				});
			}
			const body = ctx.body as any as User & {
				password: string;
				callbackURL?: string;
			} & {
				[key: string]: any;
			};
			const { name, email, password, image, callbackURL, ...additionalFields } =
				body;
			const isValidEmail = z.string().email().safeParse(email);

			if (!isValidEmail.success) {
				throw new APIError("BAD_REQUEST", {
					message: "Invalid email",
				});
			}

			const minPasswordLength = ctx.context.password.config.minPasswordLength;
			if (password.length < minPasswordLength) {
				ctx.context.logger.error("Password is too short");
				throw new APIError("BAD_REQUEST", {
					message: "Password is too short",
				});
			}

			const maxPasswordLength = ctx.context.password.config.maxPasswordLength;
			if (password.length > maxPasswordLength) {
				ctx.context.logger.error("Password is too long");
				throw new APIError("BAD_REQUEST", {
					message: "Password is too long",
				});
			}
			const dbUser = await ctx.context.internalAdapter.findUserByEmail(email);
			if (dbUser?.user) {
				ctx.context.logger.info(`Sign-up attempt for existing email: ${email}`);
				throw new APIError("UNPROCESSABLE_ENTITY", {
					message: "User with this email already exists",
				});
			}

			const additionalData = parseUserInput(
				ctx.context.options,
				additionalFields as any,
			);
			const createdUser = await ctx.context.internalAdapter.createUser({
				email: email.toLowerCase(),
				name,
				image,
				...additionalData,
				emailVerified: false,
			});
			if (!createdUser) {
				throw new APIError("BAD_REQUEST", {
					message: "Failed to create user",
				});
			}
			if (!createdUser) {
				throw new APIError("UNPROCESSABLE_ENTITY", {
					message: "Failed to create user",
				});
			}
			/**
			 * Link the account to the user
			 */
			const hash = await ctx.context.password.hash(password);
			await ctx.context.internalAdapter.linkAccount({
				userId: createdUser.id,
				providerId: "credential",
				accountId: createdUser.id,
				password: hash,
			});
			if (ctx.context.options.emailVerification?.sendOnSignUp) {
				const token = await createEmailVerificationToken(
					ctx.context.secret,
					createdUser.email,
				);
				const url = `${
					ctx.context.baseURL
				}/verify-email?token=${token}&callbackURL=${
					body.callbackURL || ctx.query?.currentURL || "/"
				}`;
				await ctx.context.options.emailVerification?.sendVerificationEmail?.(
					{
						user: createdUser,
						url,
						token,
					},
					ctx.request,
				);
			}

			if (
				!ctx.context.options.emailAndPassword.autoSignIn ||
				ctx.context.options.emailAndPassword.requireEmailVerification
			) {
				return ctx.json({
					user: createdUser as InferUser<O>,
					session: null,
				});
			}

			const session = await ctx.context.internalAdapter.createSession(
				createdUser.id,
				ctx.request,
			);
			if (!session) {
				throw new APIError("BAD_REQUEST", {
					message: "Failed to create session",
				});
			}
			await setSessionCookie(ctx, {
				session,
				user: createdUser,
			});
			return ctx.json({
				user: createdUser as InferUser<O>,
				session: session as InferSession<O>,
			});
		},
	);
