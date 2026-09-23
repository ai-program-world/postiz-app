import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { Integration } from '@prisma/client';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import {
  AuthTokenDetails,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { TemporalService } from 'nestjs-temporal-core';
import { timer } from '@gitroom/helpers/utils/timer';
import { safeStringify } from '@gitroom/nestjs-libraries/integrations/social.abstract';

@Injectable()
export class RefreshIntegrationService {
  constructor(
    private _integrationManager: IntegrationManager,
    @Inject(forwardRef(() => IntegrationService))
    private _integrationService: IntegrationService,
    private _temporalService: TemporalService
  ) {}
  async refresh(
    integration: Integration,
    cause = '',
    tolerateUnknownErrors = false
  ): Promise<false | AuthTokenDetails> {
    const socialProvider = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    const refresh = await this.refreshProcess(
      integration,
      socialProvider,
      cause,
      tolerateUnknownErrors
    );

    if (!refresh) {
      return false as const;
    }

    await this._integrationService.createOrUpdateIntegration(
      undefined,
      !!socialProvider.oneTimeToken,
      integration.organizationId,
      integration.name,
      integration.picture!,
      'social',
      integration.internalId,
      integration.providerIdentifier,
      refresh.accessToken,
      refresh.refreshToken,
      refresh.expiresIn
    );

    return refresh;
  }

  public async setBetweenSteps(integration: Integration, cause = '') {
    await this._integrationService.setBetweenRefreshSteps(integration.id);
    await this._integrationService.informAboutRefreshError(
      integration.organizationId,
      integration,
      cause
    );
  }

  public async startRefreshWorkflow(orgId: string, id: string, integration: SocialProvider) {
    if (!integration.refreshCron) {
      return false;
    }

    return this._temporalService.client
      .getRawClient()
      ?.workflow.start(`refreshTokenWorkflow`, {
        workflowId: `refresh_${id}`,
        args: [{integrationId: id, organizationId: orgId}],
        taskQueue: 'main',
        workflowIdConflictPolicy: 'TERMINATE_EXISTING',
      });
  }

  private async refreshProcess(
    integration: Integration,
    socialProvider: SocialProvider,
    cause = '',
    tolerateUnknownErrors = false
  ): Promise<AuthTokenDetails | false> {
    let refreshError: any = null;
    const refresh: false | AuthTokenDetails = await socialProvider
      .refreshToken(integration.refreshToken)
      .catch((err) => {
        refreshError = err;
        return false as const;
      });

    if (!refresh || !refresh.accessToken) {
      // Two flows can refresh the same channel at once (two posts, a post and
      // analytics). A provider that replaces the refresh token on every refresh
      // rejects the second one while the first is still storing its tokens:
      // wait for them and reuse them instead of flagging the channel.
      for (let attempt = 0; attempt < 3; attempt++) {
        const stored = await this._integrationService.getIntegrationById(
          integration.organizationId,
          integration.id
        );
        if (
          !stored ||
          stored.refreshNeeded ||
          stored.inBetweenSteps ||
          stored.deletedAt
        ) {
          break;
        }
        if (
          stored.internalId === integration.internalId &&
          stored.providerIdentifier === integration.providerIdentifier &&
          stored.refreshToken &&
          stored.refreshToken !== integration.refreshToken &&
          stored.token !== integration.token &&
          stored.tokenExpiration &&
          stored.tokenExpiration.getTime() > Date.now()
        ) {
          return {
            id: stored.internalId,
            name: stored.name,
            username: stored.profile || '',
            picture: stored.picture || '',
            accessToken: stored.token,
            refreshToken: stored.refreshToken,
            expiresIn: Math.floor(
              (stored.tokenExpiration.getTime() - Date.now()) / 1000
            ),
          };
        }
        if (attempt < 2) {
          await timer(1000 * (attempt + 1));
        }
      }

      // log a summary, not the raw error: a failed token request can carry the
      // request body (client secret, refresh token) on the error object
      console.error(
        `Refresh failed for ${integration.providerIdentifier} (${integration.id}):`,
        refreshError
          ? `message=${refreshError?.message || ''} status=${
              refreshError?.status || refreshError?.response?.status || 0
            } response=${safeStringify(
              refreshError?.details?.[0]?.json ??
                refreshError?.response?.data ??
                ''
            )}`
          : 'no access token returned'
      );

      // the scheduled refresh has no proof the token is dead, so transient /
      // unrecognized errors should not disconnect the channel there, only
      // errors the provider recognizes as an invalid refresh token. Every
      // other caller refreshes because the platform already rejected the
      // token, so they keep disconnecting.
      if (refreshError && tolerateUnknownErrors) {
        const handle = socialProvider.handleErrors?.(
          `${refreshError?.message || ''} ${safeStringify(refreshError)}`,
          refreshError?.status || refreshError?.response?.status || 0
        );

        if (handle?.type !== 'refresh-token') {
          return false;
        }
      }

      // informAboutRefreshError (with the failure cause) already notifies
      // the user, and refreshNeeded sets the same flag disconnectChannel
      // would — calling disconnectChannel here sent a second, cause-less
      // copy of the same email for every failed refresh.
      // A channel that is already flagged keeps failing on every later
      // refresh attempt (e.g. hourly analytics polling of an expired token),
      // so only the attempt that flagged it notifies.
      const flagged = await this._integrationService.refreshNeeded(
        integration.organizationId,
        integration.id
      );

      if (flagged) {
        await this._integrationService.informAboutRefreshError(
          integration.organizationId,
          integration,
          socialProvider.refreshErrorMessage?.(refreshError) || cause
        );
      }

      return false;
    }

    if (
      !socialProvider.reConnect ||
      integration.rootInternalId === integration.internalId
    ) {
      return refresh;
    }

    let reConnect;
    try {
      reConnect = await socialProvider.reConnect(
        integration.rootInternalId,
        integration.internalId,
        refresh.accessToken
      );
    } catch (err: any) {
      console.error(
        `Could not reconnect ${integration.providerIdentifier} integration ${integration.id} after a successful token refresh`,
        err?.response?.data || err?.message || err
      );
      throw err;
    }

    return {
      ...refresh,
      ...reConnect,
    };
  }
}
