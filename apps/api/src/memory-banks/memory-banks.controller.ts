import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MemoryBanksService } from './memory-banks.service';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CreateMemoryBankDto } from './dto/create-memory-bank.dto';
import { RenameMemoryBankDto } from './dto/rename-memory-bank.dto';

@ApiTags('Memory Banks')
@ApiBearerAuth()
@Controller('memory-banks')
export class MemoryBanksController {
  constructor(private memoryBanksService: MemoryBanksService) {}

  @Get()
  async list(@CurrentUser() user: { id: string }) {
    const banksList = await this.memoryBanksService.list(user.id);
    const counts = await this.memoryBanksService.getMemoryCounts(user.id);
    return {
      memoryBanks: banksList.map((b: any) => ({
        ...b,
        memoryCount: counts[b.id] || 0,
      })),
    };
  }

  @RequiresJwt()
  @Post()
  async create(@CurrentUser() user: { id: string }, @Body() dto: CreateMemoryBankDto) {
    return this.memoryBanksService.create(user.id, dto.name);
  }

  @RequiresJwt()
  @Patch(':id')
  async rename(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: RenameMemoryBankDto,
  ) {
    return this.memoryBanksService.rename(user.id, id, dto.name);
  }

  @RequiresJwt()
  @Delete(':id')
  async remove(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.memoryBanksService.remove(user.id, id);
  }
}
