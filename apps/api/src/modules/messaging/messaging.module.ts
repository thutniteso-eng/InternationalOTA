import { Module } from '@nestjs/common';
import { InboxService } from './inbox.service.js';
import { JobQueueService } from './job-queue.service.js';
import { OutboxService } from './outbox.service.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  controllers: [WebhooksController],
  providers: [OutboxService, InboxService, JobQueueService],
  exports: [OutboxService, InboxService, JobQueueService],
})
export class MessagingModule {}
