from datetime import datetime
from parameterized import parameterized
import unittest
from unittest.mock import patch, MagicMock
from phonebuddies.ResultTracker import ResultTracker
from phonebuddies.WeeklyProcess import WeeklyProcess
from phonebuddies.PhoneBuddyManager import PhoneBuddyManager
from phonebuddies.Buddy import Buddy
from phonebuddies.EmailInfo import EmailInfo

class TestPhoneBuddyManager(unittest.TestCase):


    def setUp(self):
        self.mock_buddy_map = {
            "email1@gmail.com": Buddy(["email1@gmail.com", "Pseudonym1", "Phone1", "City1", "Timezone1", "User Message1", "Full Name1", "English"]),
            "email2@gmail.com": Buddy(["email2@gmail.com", "Pseudonym2", "Phone2", "City2", "Timezone2", "User Message2", "Full Name2", "Afghan"]),
            "email3@gmail.com": Buddy(["email3@gmail.com", "Pseudonym3", "Phone3", "City3", "Timezone3", "User Message3", "Full Name3", "Afghan"])
        }

        self.mock_buddy_pairs = [
            ["email1@gmail.com", "email2@gmail.com"],
            ["email1@gmail.com", "email3@gmail.com"]
        ]

        self.mock_email_info = EmailInfo("Intro", "Topic")

        self.mock_email = "email1@gmail.com"
        self.mock_message = "admin message"

        self.today_process_date = datetime.now().strftime("%A, %B %d, %Y")


    @patch('phonebuddies.PhoneBuddyManager.EmailSender')
    @patch('phonebuddies.PhoneBuddyManager.DatabaseConnector')
    def test_send_buddy_emails_as_robot(self, mock_db_connector, mock_email_sender):
        db_instance = mock_db_connector.get_instance.return_value
        db_instance.get_all_buddies_map.return_value = self.mock_buddy_map
        db_instance.get_email_info.return_value = self.mock_email_info

        email_sender_instance = mock_email_sender.get_instance.return_value

        # Set up the object and perform the test
        manager = PhoneBuddyManager(really_send_emails=False, is_robot=True)
        manager.send_buddy_emails(self.mock_buddy_pairs)

        # Verify called the correct number of times
        self.assertEqual(email_sender_instance.send_email.call_count, len(self.mock_buddy_pairs))

        # Verify the drafts look good
        drafts_sent = [email_sender_instance.send_email.call_args_list[i][0][0] for i in range(len(self.mock_buddy_pairs))]
        for pair, draft in zip(self.mock_buddy_pairs, drafts_sent):
            first_buddy = self.mock_buddy_map[pair[0]]
            second_buddy = self.mock_buddy_map[pair[1]]

            # Verify subject looks good
            pseudonyms = (first_buddy.pseudonym, second_buddy.pseudonym)
            expected_subject = "AESOP Phone buddy introduction: %s and %s" % pseudonyms
            self.assertEqual(expected_subject, draft.subject)


    # NOTE: the 3s here are totally useless and serve only to tell @parameterized that it should
    #       treat the following list as a single parameter and not as a list of parameters
    @parameterized.expand([
        (3, ["", "", "", "", "", ""]),
        (3, ["Yes", "", "", "", "", ""]),
        (3, ["Yes", "Yes", "", "", "", ""]),
        (3, ["Yes", "Yes", "Yes", "", "", ""])
    ])
    @patch('phonebuddies.PhoneBuddyManager.EmailSender')
    @patch('phonebuddies.PhoneBuddyManager.DatabaseConnector')
    def test_manage_phone_buddy_list_remind_admins(self, useless, process_entry_data, mock_db_connector, mock_email_sender):
        process_row_data = [self.today_process_date] + process_entry_data
        db_instance = mock_db_connector.get_instance.return_value
        db_instance.get_this_weeks_process.return_value = WeeklyProcess.parse_from_google_sheet_row(process_row_data, 0)

        email_sender_instance = mock_email_sender.get_instance.return_value

        # Set up the object and perform the test
        manager = PhoneBuddyManager(really_send_emails=False, is_robot=True)
        manager.manage_phone_buddy_list()

        # Verify that emails were sent to the two admins and that the result is correct
        self.assertEqual(email_sender_instance.send_email.call_count, 2)
        self.assertEqual(ResultTracker.get_result(), "Admins reminded")

    @patch('phonebuddies.PhoneBuddyManager.EmailSender')
    @patch('phonebuddies.PhoneBuddyManager.DatabaseConnector')
    def test_manage_phone_buddy_list_send_already_sent(self, mock_db_connector, mock_email_sender):
        process_row_data = [self.today_process_date] + ['yes','yes','yes','yes','Yes','Yes']
        db_instance = mock_db_connector.get_instance.return_value
        db_instance.get_this_weeks_process.return_value = WeeklyProcess.parse_from_google_sheet_row(process_row_data, 0)
        email_sender_instance = mock_email_sender.get_instance.return_value

        # Set up the object and perform the test
        manager = PhoneBuddyManager(really_send_emails=False, is_robot=True)
        manager.manage_phone_buddy_list()

        # Verify that no emails were sent to the two admins and that the result is correct
        self.assertEqual(email_sender_instance.send_email.call_count, 0)
        self.assertEqual(ResultTracker.get_result(), "Phone buddy list already sent this week.")


#second new test

@patch('phonebuddies.PhoneBuddyManager.EmailSender')
@patch('phonebuddies.PhoneBuddyManager.DatabaseConnector')
def test_manage_phone_buddy_list_send_admin_trial_emails(self, mock_db_connector, mock_email_sender):
        process_row_data = [self.today_process_date] + ['yes','yes','yes','yes','Yes','Yes']
        db_instance = mock_db_connector.get_instance.return_value
        db_instance.get_this_weeks_process.return_value = WeeklyProcess.parse_from_google_sheet_row(process_row_data, 0)
        email_sender_instance = mock_email_sender.get_instance.return_value

        # Set up the object and perform the test
        manager = PhoneBuddyManager(really_send_emails=False, is_robot=True)
        manager.manage_phone_buddy_list()

        # Verify that emails were sent to the two admins and that the draft buddy email is correct
        self.assertEqual(email_sender_instance.send_email.call_count, 2)
        self.assertEqual(EmailDraft(email, "ACTION NEEDED: AESOP Phone Buddy Reminder", message), "email1@gmail.com", ACTION NEEDED: AESOP Phone Buddy Reminder","admin message")

#third new test

"""
@patch('phonebuddies.PhoneBuddyManager.EmailSender')
@patch('phonebuddies.PhoneBuddyManager.DatabaseConnector')
def test_manage_phone_buddy_list_send_buddy_emails(self, mock_db_connector, mock_email_sender):
        process_row_data = [self.today_process_date] + ['yes','yes','yes','yes','Yes','Yes']
        db_instance = mock_db_connector.get_instance.return_value
        db_instance.get_this_weeks_process.return_value = WeeklyProcess.parse_from_google_sheet_row(process_row_data, 0)
        email_sender_instance = mock_email_sender.get_instance.return_value

        # Set up the object and perform the test
        manager = PhoneBuddyManager(really_send_emails=False, is_robot=True)
        manager.manage_phone_buddy_list()

        # Verify that emails were sent to the two admins and that the result is correct
        self.assertEqual(email_sender_instance.send_email.call_count, 0)
        self.assertEqual(ResultTracker.get_result(), "Phone buddy list already sent this week.")
"""
#fourth new test

"""
@patch('phonebuddies.PhoneBuddyManager.EmailSender')
@patch('phonebuddies.PhoneBuddyManager.DatabaseConnector')
def test_manage_phone_buddy_list_error(self, mock_db_connector, mock_email_sender):
        process_row_data = [self.today_process_date] + ['yes','yes','yes','yes','Yes','Yes']
        db_instance = mock_db_connector.get_instance.return_value
        db_instance.get_all_buddies_map.return_value = self.mock_buddy_map
        
        #Only use the first item from self.mock_buddy_pairs so get_buddy_email_pairs returns an error
        db_instance.get_buddy_email_pairs.return_value = self.mock_buddy_pairs[0]
        db_instance.get_this_weeks_process.return_value = WeeklyProcess.parse_from_google_sheet_row(process_row_data, 0)

        email_sender_instance = mock_email_sender.get_instance.return_value

        # Set up the object and perform the test
        manager = PhoneBuddyManager(really_send_emails=False, is_robot=True)
        manager.manage_phone_buddy_list()

        # Verify that emails were sent to the two admins and that the result is correct
        self.assertEqual(email_sender_instance.send_email.call_count, 1)
        self.assertEqual(ResultTracker.get_result(), "No data in database for email in pair "email1@gmail.com" : "email3@gmail.com%")

if __name__ == '__main__':
    unittest.main()
"""