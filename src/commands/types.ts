import * as vscode from 'vscode';
import { AvailableAgentsProvider } from '../providers/AvailableAgentsProvider';
import { InstalledAgentsProvider } from '../providers/InstalledAgentsProvider';
import { MemoryTreeProvider } from '../providers/MemoryTreeProvider';
import { ConfigService } from '../services/ConfigService';
import { FileSystemService } from '../services/FileSystemService';
import { MemoryService } from '../features/memory/MemoryService';

export interface ExtensionCommand {
  readonly id: string;
  register(): vscode.Disposable;
}

export interface CommandDependencies {
  readonly context: vscode.ExtensionContext;
  readonly installedProvider: InstalledAgentsProvider;
  readonly availableProvider: AvailableAgentsProvider;
  readonly fileSystemService: FileSystemService;
  readonly configService: ConfigService;
  readonly memoryService?: MemoryService;
  readonly memoryProvider?: MemoryTreeProvider;
}
