import { Controller, HttpCode, HttpStatus, Optional, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { InboxService } from './inbox.service.js';
import { JobQueueService } from './job-queue.service.js';

/**
 * Receives incoming provider webhooks at `POST /webhooks/:provider`.
 * Relies on the raw-body middleware mounted in `app.setup.ts` before global JSON parsing.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly inboxService: InboxService,
    @Optional() private readonly jobQueueService?: JobQueueService,
  ) {}

  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Param('provider') provider: string,
    @Req() req: Request,
  ): Promise<{ accepted: true }> {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === 'string'
        ? Buffer.from(req.body, 'utf8')
        : Buffer.alloc(0);

    const received = await this.inboxService.receiveWebhook(provider, rawBody, req.headers);
    if (!received.duplicate && received.provider !== 'test') {
      this.jobQueueService?.triggerInboxRelayAsync();
    }
    return { accepted: true };
  }
}
