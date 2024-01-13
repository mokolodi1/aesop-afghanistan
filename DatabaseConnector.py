from functools import cache
import logging
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
        
        self._service = GoogleServiceProvider.sheets_service()

        with open("secrets/spreadsheet_id.txt", mode="r") as spreadsheet_id_file:
            # TODO: go to all the different places where we read from secrets and make it easier to identify errors.
            # Consider employing a more robust secrets system than a set of files sitting on the disk ;)
            self._data_spreadsheet_id = spreadsheet_id_file.read().strip()


    def _get_cells(self, cells_description):
        result = self._service.spreadsheets().values().get(
            spreadsheetId=self._data_spreadsheet_id, range=cells_description).execute()
        
        return result.get('values', [])
    

    def _set_cell(self, sheet_name, sheet_location, new_value):
        logging.debug('Setting "%s"!%s to %s' % (sheet_name, sheet_location, new_value))

        self._service.spreadsheets().values().update(
            spreadsheetId=DatabaseConnector.get_instance()._data_spreadsheet_id,
            range=f"'{sheet_name}'!{sheet_location}",
            body={"values": [[new_value]]},
            valueInputOption="RAW"
        ).execute()


    @staticmethod
    def get_database_link(self):
        """
        For use on the off chance that another class needs to refer to this spreadsheet
        """
        instance = DatabaseConnector.get_instance()

        return "https://docs.google.com/spreadsheets/d/%s/edit#gid=136000488" % instance._data_spreadsheet_id

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
                if email not in buddy_map.keys():
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

                buddies.append(buddy)
            except Exception as e:
                ResultTracker.add_issue("Error reading buddy data for row '%s': %s" % (str(row), str(e)), save_traceback=True)

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
    

    def _update_process_sheet(self, process_row_index, column, status):
        sheet_location = f"{column}{process_row_index + 3}"

        self._set_cell("Process", sheet_location, status)


    def update_process_admins_emailed(self, process: WeeklyProcess, status):
        self._update_process_sheet(process.row_index, "F", status)


    def update_process_buddies_emailed(self, process: WeeklyProcess, status):
        self._update_process_sheet(process.row_index, "G", status)


    @cache
    def get_this_weeks_process(self):
        data = self._get_cells("'Process'!A3:H500")

        processes = [WeeklyProcess.parse_from_google_sheet_row(row, index) for index, row in enumerate(data)]

        # Remove the invalid entries (parse_from_google_sheet_row returns None if invalid)
        processes = [process for process in processes if process is not None]

        # Find this week's process object
        this_week = next((process for process in processes if process.is_current_week), None)

        if this_week is None:
            raise Exception("This week's process not found on the spreadshet")
        
        return this_week
    
    def get_email_info(self):
        raw_rows = self._get_cells("'Email info'!A2:B500")

        def _find_labeled_row_text(label_text):
            return next(row[1] for row in raw_rows if row[0] == label_text)

        intro = _find_labeled_row_text("Intro")
        topic = _find_labeled_row_text("Topic")
        return EmailInfo(intro, topic)
    
    def lock_database():
        # TODO
        pass

    def unlock_database():
        # TODO
        pass