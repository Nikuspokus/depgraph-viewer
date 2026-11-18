import { Module, forwardRef } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [forwardRef(() => AuthModule)],
  providers: [UsersService, { provide: 'TOKEN', useValue: 1 }],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
