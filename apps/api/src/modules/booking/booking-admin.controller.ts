import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../identity/index.js';
import { BookingService } from './booking.service.js';
import type { CustomerBookingListResponse } from './booking.types.js';

@Controller('admin/bookings')
@UseGuards(AuthGuard, RolesGuard)
@Roles('admin', 'operator')
export class BookingAdminController {
  constructor(private readonly bookingService: BookingService) {}

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('departureId') departureId?: string,
    @Query('departure') departure?: string,
    @Query('reference') reference?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<CustomerBookingListResponse> {
    const depFilter = departureId ?? departure;
    return this.bookingService.listAdminBookings({
      ...(status !== undefined ? { status } : {}),
      ...(depFilter !== undefined ? { departureId: depFilter } : {}),
      ...(reference !== undefined ? { reference } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }
}
