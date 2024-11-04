import { getDB, transaction } from "@hasura/ndc-duckduckapi";
import * as linear from "./linear";

export class LinearSyncManager {
  private url = 'https://api.linear.app/graphql';
  private token: string = '';
  private syncInterval: NodeJS.Timeout | null = null;

  constructor() {
    console.log(`Initializing Linear sync`);
  }

  private async linearFetch(query: string): Promise<any> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        'Authorization': `${this.token}`,
        'User-Agent': 'Linear-Issue-Sync',
        "Content-Type": "application/json"
      },
      body: query
    });
    if (!response.ok) {
      const error = await response.text().catch(() => null);
      throw new Error(`Linear API error (${response.status}): ${error}`);
    }
    return response.json();
  }

  async initialize(token: string): Promise<boolean> {
    try {

      this.getSyncStatus();
      console.log('Starting initialization...');
      this.token = token;
      
      // Validate token by fetching user info
      console.log('Validating Linear token: ...');
      const query = "query Me { viewer { id } }";
      await this.linearFetch(JSON.stringify({query: query}));
      console.log('Token validation successful');

      // Start initial sync
      console.log('Starting initial sync...');
      await this.syncIssuesAndComments();
      console.log('Initial sync complete');
      
      // Set up continuous sync
      console.log('Setting up continuous sync (5 minute interval)...');
      this.syncInterval = setInterval(() => this.syncIssuesAndComments(), 5 * 60 * 1000);
      
      return true;
    } catch (error) {
      console.error('Initialization failed:', error);
      return false;
    }
  }

  private async syncIssuesAndComments(): Promise<void> {
    try {
      console.log('Starting sync cycle...');
      const db = await getDB();

      // Start initial sync
      console.log('Starting team sync...');
      const teams = await this.syncTeams();
      console.log('Team sync complete');

      for (const team of teams) {
        const lastSync = await this.getLastIssueSyncState(team.id);
        console.log(`Last issue sync for team ${team.name}: ${lastSync || 'never'}`);  
        console.log(`Syncing issues for team ${team.name} since ${lastSync || 'the beginning'}`);
  
        const issues = await this.fetchAllIssues(team.id, lastSync);
        console.log(`Fetched ${issues.length} issues for team: ${team.name}`);
        
        await this.saveIssues(issues, lastSync)
        await this.updateIssueSyncState(team.id);

        for (const issue of issues) {
          if (issue.comments && issue.comments.nodes.length > 0) {
            const lastCommentSync = await this.getCommentSyncState(issue.id, issue.identifier);
            
            const needsCommentSync = !lastCommentSync || 
              new Date(issue.updatedAt) > new Date(lastCommentSync);
            
            if (needsCommentSync) {
              console.log(`Syncing comments for issue #${issue.identifier} (${issue.comments.nodes.length} comments)`);
              await this.saveComments(issue.comments.nodes, issue.id, issue.identifier);
              await this.updateCommentSyncState(issue.id, issue.identifier);
            }
          }
        }
      }
      
    } catch (error) {
      console.error('Sync cycle failed:', error);
    }
  }

  public async syncTeams(): Promise<linear.LinearTeamResponse[]> {
    const db = await getDB();
    const teams = await this.fetchTeams();
    await transaction(db, async (tx) => {
      for (const team of teams) {
        await tx.run(`
          INSERT INTO linear_teams (
            id,
            name,
            key,
            description,
            created_at,
            updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?
          )
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            key = excluded.key,
            description = excluded.description,
            updated_at = excluded.updated_at
        `,
          team.id,
          team.name,
          team.key,
          team.description,
          new Date(team.createdAt),
          new Date(team.updatedAt)
        );

        // Update sync state for this team
        await tx.run(`
          INSERT INTO linear_sync_state (
            team_id,
            last_issue_sync,
            last_project_sync
          ) VALUES (
            ?, NULL, NULL
          )
          ON CONFLICT(team_id) DO NOTHING
        `, [team.id]);
      }
    });
    return teams;
  }

  private async fetchTeams(): Promise<linear.LinearTeamResponse[]> {
    const response = await this.linearFetch(JSON.stringify({query: linear.teamsQuery}));
    return response.data.teams.nodes;
  }

  private async getLastIssueSyncState(team: string): Promise<string | undefined> {
    const db = await getDB();
    try {
      const result = await db.all(`
        SELECT last_issue_sync
        FROM linear_sync_state
        WHERE team_id = ?`,
        [team]);
        return result.length > 0 ? result[0].last_issue_sync : null;
    } catch (error) {
      console.error('Failed to get issue sync state:', error);
      throw error;
    }
  }

  private async getCommentSyncState(issueId: string, issueReadableId: string): Promise<string | null> {
    const db = await getDB();
    try {
      const result = await db.all(
        `SELECT last_comment_sync 
         FROM linear_comment_sync_state 
         WHERE issue_id = ?`,
        issueId
      );
      return result.length > 0 ? result[0].last_comment_sync : null;
    } catch (error) {
      console.error(`Failed to get comment sync state for issue ${issueReadableId}:`, error);
      throw error;
    }
  }

  private async updateIssueSyncState(team: string): Promise<void> {
    try {
    const db = await getDB();
      await transaction(db, async (conn) => {
        await conn.run(`
          INSERT INTO linear_sync_state (team_id, last_issue_sync)
          VALUES (?, ?)
          ON CONFLICT(team_id) DO UPDATE SET last_issue_sync = ?
        `, team, new Date().toISOString(), new Date().toISOString());
      });
      console.log('Issue sync state updated');
    } catch (error) {
      console.error('Failed to update issue sync state:', error);
      throw error;
    }
  }

  private async updateCommentSyncState(issueId: string, issueReadableId: string): Promise<void> {
    try {
      const db = await getDB();
      await transaction(db, async (conn) => {
        await conn.run(`
          INSERT INTO linear_comment_sync_state (issue_id, last_comment_sync)
          VALUES (?, ?)
          ON CONFLICT(issue_id) DO UPDATE SET last_comment_sync = ?
        `, issueId, new Date().toISOString(), new Date().toISOString());
      });
      console.log(`Comment sync state updated for issue ${issueReadableId}`);
    } catch (error) {
      console.error(`Failed to update comment sync state for issue ${issueReadableId}:`, error);
      throw error;
    }
  }

  private async fetchAllIssues(teamId: string, since?: string): Promise<linear.LinearIssueResponse[]> {
    let hasNextPage = true;
    let cursor: string | undefined;
    const issues : linear.LinearIssueResponse[] = [];
    while (hasNextPage) {

      const response = await this.linearFetch(JSON.stringify({
        query: linear.issuesQuery, 
        variables: {
          teamId,
          after: cursor || null,
          filter: since ? {updatedAt: {gte: since}} : null
        }
      })) 
       
      issues.push(...response.data.team.issues.nodes)
      hasNextPage = response.data.team.issues.pageInfo.hasNextPage;
      cursor = response.data.team.issues.pageInfo.endCursor;
    }
    
    return issues
  }

  private async saveIssues(issues: linear.LinearIssueResponse[], lastSync: string | undefined): Promise<void> {
    try {
      const db = await getDB();
      await transaction(db, async (tx) => {
        for (const issue of issues) {
          // Skip issues that haven't been updated since last sync
          if (lastSync && new Date(issue.updatedAt) <= new Date(lastSync)) {
            continue;
          }

          const labelString = issue.labels.nodes
            .map(label => label.name)
            .join(',');

          await tx.run(`
            INSERT INTO linear_issues (
              id, team_id, title, description,
              state, priority, number, identifier, created_at, updated_at,
              completed_at, creator_email, creator_name, assignee_email,
              assignee_name, bot_type, bot_user, link_type, link_url,
              labels
            ) VALUES (
              ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?
            )
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              description = excluded.description,
              state = excluded.state,
              priority = excluded.priority,
              identifier = excluded.identifier,
              updated_at = excluded.updated_at,
              completed_at = excluded.completed_at,
              assignee_email = excluded.assignee_email,
              assignee_name = excluded.assignee_name,
              link_type = excluded.link_type,
              link_url = excluded.link_url,
              labels = excluded.labels
          `,
            issue.id,
            issue.team.id,
            issue.title,
            issue.description,
            issue.state.name,
            issue.priority,
            issue.number,
            issue.identifier,
            new Date(issue.createdAt),
            new Date(issue.updatedAt),
            issue.completedAt ? new Date(issue.completedAt) : null,
            issue.creator? issue.creator.email : null,
            issue.creator? issue.creator.name : null,
            issue.assignee? issue.assignee.email : null,
            issue.assignee? issue.assignee.name : null,
            issue.botActor? issue.botActor.name : null,
            issue.botActor? issue.botActor.userDisplayName : null,
            issue.attachments && issue.attachments.nodes.length > 0 ?  issue.attachments.nodes[0].sourceType : null,
            issue.attachments && issue.attachments.nodes.length > 0 ?  issue.attachments.nodes[0].url : null,
            issue.labels && issue.labels.nodes.length > 0 ? JSON.stringify(issue.labels.nodes.map(l => l.name).join(',')) : null
          );
        }
      });
      console.log(`Saved ${issues.length} issues to database`);
    } catch (error) {
      console.error('Failed to save issues:', error);
      throw error;
    }
  }

  private async saveComments(comments: linear.LinearComment[], issueId: string, issueReadableId: string): Promise<void> {
    try {
      const db = await getDB();
      await transaction(db, async (conn) => {
        // If this is a full sync, clear existing comments
        const lastSync = await this.getCommentSyncState(issueId, issueReadableId);
        if (!lastSync) {
          console.log(`Performing full comment sync for issue ID ${issueId}, clearing existing comments...`);
          await conn.run(
            `DELETE FROM linear_comments WHERE issue_id = ?`,
            issueId,
          );
        }

        // Insert or update new comments
        for (const comment of comments) {
          await conn.run(`
            INSERT OR REPLACE INTO linear_comments (
              id, issue_id, body, user_email, user_name, bot_type, bot_user, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          comment.id,
          issueId,
          comment.body,
          comment.user? comment.user.email : null,
          comment.user? comment.user.name : null,
          comment.botActor? comment.botActor.name: null,
          comment.botActor? comment.botActor.userDisplayName: null,
          new Date(comment.createdAt),
          new Date(comment.updatedAt),
          );
        }
      });
      console.log(`Saved ${comments.length} comments for issue ID ${issueReadableId}`);
    } catch (error) {
      console.error(`Failed to save comments for issue ${issueReadableId}:`, error);
      throw error;
    }
  }

  public async getIssueComments(issueId: string): Promise<any[]> {
    try {
      const db = await getDB();
      return await db.all(`
        SELECT * 
        FROM linear_comments
        WHERE issue_id = ?
        ORDER BY c.created_at ASC
      `, issueId,);
    } catch (error) {
      console.error(`Failed to get comments for issue #${issueId}:`, error);
      throw error;
    }
  }

  public async getSyncStatus(): Promise<any> {
    try {
      const db = await getDB();
      const teams = await db.all(`
        SELECT id, name
        FROM linear_teams`);
      
      const stats = []
      for (const team of teams) {
        const issueSync = await this.getLastIssueSyncState(team.id);
        const repoStats = await db.all(`
          SELECT 
            COUNT(DISTINCT i.id) as total_issues,
            COUNT(DISTINCT c.id) as total_comments,
            MAX(i.updated_at) as latest_issue_update,
            MAX(c.updated_at) as latest_comment_update
          FROM linear_issues i
          LEFT JOIN linear_comments c ON i.id = c.issue_id
        `);
          stats.push({
            team: team.name,
            last_issue_sync: issueSync,
            stats: repoStats[0]
          })
      }
  
      return stats;
    } catch (error) {
      console.error('Failed to get sync status:', error);
      throw error;
    }
  }

  public async searchIssues(query: string): Promise<any[]> {
    try {
      const db = await getDB();
      return await db.all(`
        SELECT i.*, t.name
        FROM linear_issues i
        JOIN linear_teams t ON t.id = i.team_id
        AND (
          i.title LIKE ?
          OR i.description LIKE ?
          OR i.creator_name LIKE ?
          OR i.bot_type LIKE ?
          OR i.bot_user LIKE ?
          OR i.labels LIKE ?
          OR i.identifier LIKE ?
          OR t.name LIKE ?
        )
        ORDER BY i.updated_at DESC
      `,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`
      );
    } catch (error) {
      console.error(`Failed to search issues with query "${query}":`, error);
      throw error;
    }
  }

  public async searchComments(query: string): Promise<any[]> {
    try {
      const db = await getDB();
      return await db.all(`
        SELECT c.*, i.number as issue_number
        FROM linear_comments c
        JOIN linear_issues i ON i.id = c.issue_id
        AND (
          c.body LIKE ?
          OR c.user_name LIKE ?
          OR c.bot_user LIKE ?
        )
        ORDER BY c.updated_at DESC
      `,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`
      );
    } catch (error) {
      console.error(`Failed to search comments with query "${query}":`, error);
      throw error;
    }
  }

  public stop(): void {
    if (this.syncInterval) {
      console.log('Stopping sync process...');
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log('Sync process stopped');
    }
  }

  public async cleanup(): Promise<void> {
    try {
      const db = await getDB();
      console.log('Starting cleanup process...');
      await transaction(db, async (conn) => {
        // Remove all data for this repository
        await conn.run(
          `DELETE FROM linear_comments`
        );
        await conn.run(
          `DELETE FROM linear_issues`
        );
        await conn.run(
          `DELETE FROM linear_sync_state`
        );
        await conn.run(
          `DELETE FROM linear_comment_sync_state`
        );
      });
      console.log('Cleanup complete');
    } catch (error) {
      console.error('Failed to cleanup repository data:', error);
      throw error;
    }
  }
}