from functools import cache
from Buddy import Buddy
from EmailInfo import EmailInfo
from GoogleServiceProvider import GoogleServiceProvider
from ResultTracker import ResultTracker
from WeeklyProcess import WeeklyProcess


class DatabaseConnector:
    """
    Singleton class that connects to Google Sheets as the database
    """

    _instance = None

    @staticmethod
    def get_instance():
        if DatabaseConnector._instance is None:
            DatabaseConnector._instance = DatabaseConnector()

        return DatabaseConnector._instance

    def __init__(self):
        if DatabaseConnector._instance is not None:
            raise Exception("This class is a singleton!")
        else:
            self.service = GoogleServiceProvider.sheets_service()

            with open("secrets/spreadsheet_id.txt", mode="r") as spreadsheet_id_file:
                self._data_spreadsheet_id = spreadsheet_id_file.read()

    def _get_cells(self, cells_description):
        result = self.service.spreadsheets().values().get(
            spreadsheetId=self._data_spreadsheet_id, range=cells_description).execute()
        
        return result.get('values', [])
    

    @staticmethod
    def get_database_link(self):
        """
        For use on the off chance that another class needs to refer to this spreadsheet
        """
        instance = DatabaseConnector.get_instance()

        return "https://docs.google.com/spreadsheets/d/{DATA_SPREADSHEET_ID}/edit#gid=136000488" % instance._data_spreadsheet_id

    @cache
    def get_buddy_email_pairs(self):
        rows = self._get_cells("'Matched'!A2:B500")

        # Grab all rows where the length was greater than 2
        pairs = [r[0:2] for r in rows if len(r) >= 2]

        # Validate that all the buddy pairs have a valid buddy, skip those with issues
        valid_pairs = []
        buddy_map = self.get_all_buddies_map()
        for pair in pairs:
            reject_pair = False

            for email in pair:
                if email not in buddy_map:
                    ResultTracker.add_issue("No data in database for email in pair '%s': '%s'" % (str(pair), email))
                    reject_pair = True
            
            if not reject_pair:
                valid_pairs.append(pair)

        return pairs


    @cache
    def get_all_buddies(self):
        rows = self._get_cells("'Database'!A4:I500")

        buddies = []

        for row in rows:
            try:
                buddy = Buddy(row)
            except Exception as e:
                ResultTracker.add_issue("Error reading buddy data for row '%s': %s" % (str(row), str(e)))

        return buddies


    @cache
    def get_all_buddies_map(self):
        """
        Returns a map of all buddies where the index is the email of the buddy.
        """
        buddy_email_map = {}

        for buddy in self.get_all_buddies():
            buddy_email_map[buddy.email] = buddy

        return buddy_email_map


    def set_error_message(drive_service, error_message):
        """
        Sets the error message so that it can be viewed by a user for easy diagnosis.
        """
        drive_service.spreadsheets().values().update(
            spreadsheetId=DatabaseConnector.get_instance()._data_spreadsheet_id,
            range=f"'Errors'!A1",
            body={"values": [[error_message]]},
            valueInputOption="RAW"
        ).execute()

    def update_process_sheet(drive_service, beta_email, row_number, status):
        if row_number is None:
            print("Row number is None - must be a human running this when the process is messed up...")
            print("Not updating anything on the process sheet!")
            return

        sheet_location = f"{'F' if beta_email else 'G'}{row_number + 2 + 1}"
        print("Updating process sheet: %s to %s" % (sheet_location, status))

        drive_service.spreadsheets().values().update(
            spreadsheetId=DatabaseConnector.get_instance()._data_spreadsheet_id,
            range=f"'Process'!{sheet_location}",
            body={"values": [[status]]},
            valueInputOption="RAW"
        ).execute()

    def get_this_weeks_process(self):
        data = self._get_cells("'Process'!A3:H500").execute()

        processes = [WeeklyProcess.parse_from_google_sheet_row(row) for row in data]

        # Remove the invalid entries (parse_from_google_sheet_row returns None if invalid)
        processes = [process for process in processes if process is not None]

        # Find this week's process object
        this_week = next((process for process in processes if process.is_current_week), None)

        if this_week is None:
            raise Exception("This week's process not found on the spreadshet")
        
        return this_week
    
    def get_email_info():
        def _find_labeled_row_text(self, label_text):
            return next(row[1] for row in self._raw_rows if row[0] == label_text)

        result = DatabaseConnector.get_instance().service.spreadsheets().values().get(
            spreadsheetId=DatabaseConnector.get_instance()._data_spreadsheet_id,
            range="'Email info'!A2:B500").execute()
        raw_rows = result.get('values', [])

        intro = _find_labeled_row_text("Intro")
        topic = _find_labeled_row_text("Topic")
        return EmailInfo(intro, topic)
    
    def lock_database():
        # TODO
        pass

    def unlock_database():
        # TODO
        pass