import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Idempotent } from '../idempotency/index.js';
import {
  AuthGuard,
  CurrentPrincipal,
  type Principal,
  Roles,
  RolesGuard,
} from '../identity/index.js';
import type {
  AdminRefundDto,
  AdminRefundListResponse,
  DepartureCancellationSummaryDto,
  DepartureCancelRequestDto,
  DepartureCancelResultDto,
  RejectBookingRequestDto,
  RejectBookingResultDto,
} from './payments.types.js';
import { RefundService } from './refund.service.js';

@Controller('admin')
@UseGuards(AuthGuard, RolesGuard)
@Roles('admin', 'operator')
export class RefundAdminController {
  constructor(private readonly refundService: RefundService) {}

  @Get('refunds')
  async listRefunds(
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<AdminRefundListResponse> {
    return this.refundService.listAdminRefunds({
      ...(status !== undefined ? { status } : { status: 'manual_review,failed' }),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  @Post('departures/:id/cancel')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async cancelDeparture(
    @CurrentPrincipal() principal: Principal,
    @Param('id') departureId: string,
    @Body() body?: DepartureCancelRequestDto,
  ): Promise<DepartureCancelResultDto> {
    return this.refundService.cancelDeparture(departureId, principal.userId, body?.reason);
  }

  @Get('departures/:id/cancellation-summary')
  async getDepartureCancellationSummary(
    @Param('id') departureId: string,
  ): Promise<DepartureCancellationSummaryDto> {
    return this.refundService.getDepartureCancellationSummary(departureId);
  }

  @Post('bookings/:reference/reject')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async rejectBooking(
    @CurrentPrincipal() principal: Principal,
    @Param('reference') reference: string,
    @Body() body?: RejectBookingRequestDto,
  ): Promise<RejectBookingResultDto> {
    return this.refundService.rejectConfirmedBooking(reference, principal.userId, body?.reason);
  }

  @Post('refunds/:id/retry')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async retryRefund(
    @CurrentPrincipal() principal: Principal,
    @Param('id') refundId: string,
    @Body() body?: { reason?: string },
  ): Promise<AdminRefundDto> {
    return this.refundService.adminRetryRefund(refundId, principal.userId, body?.reason);
  }
}
